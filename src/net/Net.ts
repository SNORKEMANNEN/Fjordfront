import Peer, { DataConnection } from 'peerjs';
import type { PeerOptions } from 'peerjs';

/**
 * Peer-to-peer transport (WebRTC data channels via PeerJS). One player hosts and gets a short
 * room code; everyone else connects straight to the host. The PeerJS broker only introduces the
 * browsers (no game traffic goes through it). For tests a local broker: `?peer=host:port`.
 *
 * Two channels per player:
 *  - "rel": reliable, ordered JSON — events (shots, hits, deaths, chat, roster, match state);
 *  - "st":  UNRELIABLE, unordered, raw binary — the 20 Hz pose snapshots. A lost or late snapshot
 *           is simply superseded by the next one, so it never holds up the stream behind it (no
 *           head-of-line blocking spikes) and it costs a fraction of the bytes of JSON text.
 *
 * Connectivity: STUN servers are always used; a TURN relay (for school / office networks that block
 * direct peer-to-peer) can be configured in Settings → Multiplayer. `diagnose()` reports how a
 * connection actually got through (direct LAN, through NAT, or relayed) and `testIce()` checks what
 * this network allows before you try.
 */
export type NetMsg = { t: string; [k: string]: unknown };

const PREFIX = 'fjordfront-v1-';
export const LOBBY_ID = PREFIX + 'lobby-registry';
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  return s;
}
export function cleanCode(c: string) {
  return c.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

/** user TURN / relay settings (stored in localStorage by the settings screen) */
export interface IceSettings {
  turnUrl: string;
  turnUser: string;
  turnPass: string;
  relayOnly: boolean;
}
export function loadIce(): IceSettings {
  try {
    return { turnUrl: '', turnUser: '', turnPass: '', relayOnly: false, ...JSON.parse(localStorage.getItem('ff.ice') || '{}') };
  } catch {
    return { turnUrl: '', turnUser: '', turnPass: '', relayOnly: false };
  }
}
export function saveIce(s: IceSettings) {
  try {
    localStorage.setItem('ff.ice', JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
export function iceConfig(): RTCConfiguration {
  const s = loadIce();
  const servers: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }];
  if (s.turnUrl) servers.push({ urls: s.turnUrl.split(/[\s,]+/).filter(Boolean), username: s.turnUser || undefined, credential: s.turnPass || undefined });
  return { iceServers: servers, iceTransportPolicy: s.relayOnly && s.turnUrl ? 'relay' : 'all' };
}

export function peerOptions(): PeerOptions {
  const q = new URLSearchParams(location.search).get('peer');
  const config = iceConfig();
  if (q) {
    const [host, port] = q.split(':');
    return { host, port: +(port || 9000), path: '/', secure: false, debug: 1, config };
  }
  return { debug: 1, config };
}

interface Chan {
  rel: DataConnection | null;
  st: DataConnection | null;
}

export class Net {
  peer: Peer | null = null;
  role: 'off' | 'host' | 'client' = 'off';
  code = '';
  /** host: open connections by peer id (reliable channel) */
  conns = new Map<string, DataConnection>();
  private chans = new Map<string, Chan>();
  /** client: the connection to the host */
  hostConn: DataConnection | null = null;
  private hostSt: DataConnection | null = null;
  onMessage: (from: string, m: NetMsg) => void = () => {};
  /** binary state packets */
  onState: (from: string, buf: ArrayBuffer) => void = () => {};
  onPeerLeave: (id: string) => void = () => {};
  onPeerJoin: (id: string) => void = () => {};
  onClosed: (why: string) => void = () => {};
  /** incoming media (voice) calls */
  onCall: (call: import('peerjs').MediaConnection) => void = () => {};
  /** bytes sent / received in the last second (for /net and the F3 overlay) */
  stats = { up: 0, down: 0, _up: 0, _down: 0, t: 0 };

  get myId() {
    return this.peer?.id ?? '';
  }

  host(code = makeCode(), retryTaken = false): Promise<string> {
    this.close();
    return new Promise((resolve, reject) => {
      const p = new Peer(PREFIX + code, peerOptions());
      this.peer = p;
      let opened = false;
      p.on('open', () => {
        opened = true;
        this.role = 'host';
        this.code = code;
        resolve(code);
      });
      p.on('connection', (c) => this.accept(c));
      p.on('call', (c) => this.onCall(c));
      p.on('error', (e: Error & { type?: string }) => {
        if (this.peer !== p) return; // (a replaced peer: ignore)
        if (!opened) {
          if (e.type === 'unavailable-id') {
            // the code is taken: a new one — or, when taking over a room (host migration), the
            // old host's id is still being released: the caller retries the same code
            if (retryTaken) reject(Object.assign(new Error('taken'), { taken: true }));
            else this.host().then(resolve, reject);
          } else reject(new Error(this.describe(e)));
        } else console.warn('[net]', e.type, e.message);
      });
      p.on('disconnected', () => {
        // lost the broker: running games keep going, new joins need it back
        if (this.role === 'host' && !p.destroyed) p.reconnect();
      });
    });
  }

  join(code: string, hello: NetMsg): Promise<void> {
    this.close();
    code = cleanCode(code);
    return new Promise((resolve, reject) => {
      const p = new Peer(peerOptions());
      this.peer = p;
      // (callbacks of a connection that has since been replaced — e.g. the old host's dying
      // connection during a host migration — must not close the new one)
      const fail = (why: string) => {
        reject(new Error(why));
        if (this.peer === p) this.close();
      };
      const timer = setTimeout(() => fail('No answer from that room. Check the code, and that the host is still in the game.'), 15000);
      p.on('open', () => {
        const c = p.connect(PREFIX + code, { reliable: true, serialization: 'json', label: 'rel' });
        this.hostConn = c;
        c.on('open', () => {
          clearTimeout(timer);
          this.role = 'client';
          this.code = code;
          this.wire(c, 'host');
          // (my peer id: other players call it for voice chat)
          c.send({ ...hello, pid: p.id });
          // the unreliable binary state channel (optional: JSON fallback while it isn't open)
          try {
            const st = p.connect(PREFIX + code, { reliable: false, serialization: 'raw', label: 'st' });
            st.on('open', () => {
              this.hostSt = st;
              this.wireState(st, 'host');
            });
          } catch (e) {
            console.warn('[net] no state channel', e);
          }
          resolve();
        });
        c.on('error', (e) => fail('Connection failed: ' + e.message));
      });
      p.on('call', (c) => this.onCall(c));
      p.on('error', (e: Error & { type?: string }) => {
        clearTimeout(timer);
        if (this.role !== 'client') fail(this.describe(e));
        else console.warn('[net]', e.type, e.message);
      });
    });
  }

  private describe(e: Error & { type?: string }) {
    switch (e.type) {
      case 'peer-unavailable': return 'No room with that code.';
      case 'network': case 'server-error': case 'socket-error': case 'socket-closed': return 'Could not reach the matchmaking server. Check your internet connection.';
      case 'browser-incompatible': return 'This browser does not support peer-to-peer connections.';
      default: return e.message || String(e.type);
    }
  }

  private chan(id: string) {
    let c = this.chans.get(id);
    if (!c) this.chans.set(id, (c = { rel: null, st: null }));
    return c;
  }

  private accept(c: DataConnection) {
    c.on('open', () => {
      if (c.label === 'st') {
        this.chan(c.peer).st = c;
        this.wireState(c, c.peer);
        return;
      }
      if (c.label === 'lobby') {
        // a lobby registry query / announcement (only when this host is the registry)
        this.onLobby?.(c);
        return;
      }
      this.conns.set(c.peer, c);
      this.chan(c.peer).rel = c;
      this.wire(c, c.peer);
      this.onPeerJoin(c.peer);
    });
  }
  /** set by the lobby registry role */
  onLobby: ((c: DataConnection) => void) | null = null;

  private wire(c: DataConnection, id: string) {
    c.on('data', (d) => {
      try {
        const s = typeof d === 'string' ? d : JSON.stringify(d);
        this.stats._down += s.length;
        const m = (typeof d === 'string' ? JSON.parse(d) : d) as NetMsg;
        this.onMessage(id, m);
      } catch (e) {
        console.warn('[net] bad message', e);
      }
    });
    c.on('close', () => {
      if (this.role === 'host') {
        this.conns.delete(c.peer);
        const ch = this.chans.get(c.peer);
        ch?.st?.close();
        this.chans.delete(c.peer);
        this.onPeerLeave(c.peer);
      } else if (this.role === 'client' && c === this.hostConn) {
        this.role = 'off';
        this.onClosed('The host left the game.');
      }
    });
  }

  private wireState(c: DataConnection, id: string) {
    c.on('data', (d) => {
      let buf: ArrayBuffer | null = null;
      if (d instanceof ArrayBuffer) buf = d;
      else if (ArrayBuffer.isView(d)) buf = (d.buffer as ArrayBuffer).slice(d.byteOffset, d.byteOffset + d.byteLength);
      if (!buf) return;
      this.stats._down += buf.byteLength;
      this.onState(id, buf);
    });
  }

  /** client → host, or host → one peer (reliable) */
  send(m: NetMsg, to?: string) {
    const c = this.role === 'client' ? this.hostConn : to ? this.conns.get(to) : null;
    if (!c || !c.open) return;
    const s = JSON.stringify(m);
    this.stats._up += s.length;
    c.send(s);
  }
  /** host → every client (optionally except one) (reliable) */
  broadcast(m: NetMsg, except?: string) {
    if (this.role !== 'host') return;
    const s = JSON.stringify(m);
    for (const [id, c] of this.conns) {
      if (id === except || !c.open) continue;
      this.stats._up += s.length;
      c.send(s);
    }
  }
  /** binary state, unreliable: false when there is no state channel (caller falls back) */
  sendState(buf: ArrayBuffer, to?: string) {
    const c = this.role === 'client' ? this.hostSt : to ? this.chans.get(to)?.st ?? null : null;
    if (!c || !c.open) return false;
    try {
      c.send(buf);
    } catch {
      return false;
    }
    this.stats._up += buf.byteLength;
    return true;
  }
  /** does this peer have the state channel open? */
  hasState(to?: string) {
    const c = this.role === 'client' ? this.hostSt : to ? this.chans.get(to)?.st ?? null : null;
    return !!c?.open;
  }
  kick(id: string) {
    this.conns.get(id)?.close();
  }

  tickStats(now: number) {
    const s = this.stats;
    if (now - s.t < 1) return;
    s.up = s._up / (now - s.t);
    s.down = s._down / (now - s.t);
    s._up = s._down = 0;
    s.t = now;
  }

  /**
   * How a connection got through: the selected ICE candidate pair (host = same network,
   * srflx/prflx = direct through NAT, relay = via a TURN server) and the measured round trip.
   */
  async diagnose(to?: string): Promise<{ type: string; protocol: string; rtt: number } | null> {
    const c = this.role === 'client' ? this.hostConn : to ? this.conns.get(to) : [...this.conns.values()][0];
    const pc = c?.peerConnection;
    if (!pc) return null;
    try {
      const stats = await pc.getStats();
      let pair: RTCStats & Record<string, any> | null = null;
      stats.forEach((r: any) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
      });
      if (!pair) stats.forEach((r: any) => {
        if (r.type === 'candidate-pair' && (r.selected || r.nominated) && r.state === 'succeeded') pair = r;
      });
      if (!pair) return null;
      const p = pair as any;
      const local = stats.get(p.localCandidateId) as any, remote = stats.get(p.remoteCandidateId) as any;
      const kinds = [local?.candidateType, remote?.candidateType];
      const type = kinds.includes('relay') ? 'relayed (TURN)' : kinds.includes('srflx') || kinds.includes('prflx') ? 'direct through NAT' : 'direct (same network)';
      return { type, protocol: local?.protocol ?? '?', rtt: (p.currentRoundTripTime ?? 0) * 1000 };
    } catch {
      return null;
    }
  }

  close() {
    // detach everything first, then close: closing a connection fires its 'close' event right
    // away, and a handler that reacts by opening a new peer (host migration) must not have that
    // new peer torn down by the rest of this call
    const conns = [...this.conns.values()], chans = [...this.chans.values()];
    const hc = this.hostConn, hs = this.hostSt, p = this.peer;
    this.conns.clear();
    this.chans.clear();
    this.hostConn = null;
    this.hostSt = null;
    this.peer = null;
    this.role = 'off';
    this.code = '';
    for (const c of conns) c.close();
    for (const ch of chans) ch.st?.close();
    hc?.close();
    hs?.close();
    if (p && !p.destroyed) p.destroy();
  }

}

/**
 * What this network lets through, before trying: gathers ICE candidates against the configured
 * STUN / TURN servers. host = local addresses, srflx = STUN answered (direct peer-to-peer through
 * NAT likely works), relay = the TURN relay works (works almost anywhere).
 */
export async function testIce(timeoutMs = 4000) {
  const pc = new RTCPeerConnection(iceConfig());
  const found = { host: 0, srflx: 0, relay: 0 };
  pc.createDataChannel('probe');
  pc.onicecandidate = (e) => {
    const c = e.candidate?.candidate ?? '';
    const m = / typ (host|srflx|relay|prflx)/.exec(c);
    if (m) found[(m[1] === 'prflx' ? 'srflx' : m[1]) as keyof typeof found]++;
  };
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise<void>((r) => {
    const t = setTimeout(r, timeoutMs);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        r();
      }
    };
  });
  pc.close();
  const s = loadIce();
  const verdict = found.relay ? 'Relay (TURN) works: joining should work from this network.'
    : found.srflx ? (s.turnUrl ? 'Direct connections should work. The TURN server did not answer (check its address / login).' : 'Direct connections should work. Strict school / office networks may still block them: add a TURN server below if joining fails.')
    : 'This network blocks the STUN check: direct peer-to-peer is unlikely to work. Add a TURN relay server below.';
  return { ...found, verdict };
}

/**
 * Room browser without a server: one host at a time claims a well-known registry id; every public
 * host announces its room to it every few seconds, and the browser asks it for the list. If the
 * registry host leaves, the next host to announce claims the id.
 */
export interface RoomInfo { code: string; name: string; players: number; max: number; map: string; t?: number }
export class LobbyRegistry {
  private reg: Peer | null = null;
  private rooms = new Map<string, RoomInfo>();
  private timer = 0;
  /** host side: keep announcing `info()` (null stops) */
  announce(info: () => RoomInfo | null) {
    clearInterval(this.timer);
    const tick = async () => {
      const r = info();
      if (!r) return;
      const ok = await this.post(r);
      if (!ok && !this.reg) await this.claim();
      if (this.reg) this.store(r);
    };
    tick();
    this.timer = window.setInterval(tick, 8000);
  }
  stop() {
    clearInterval(this.timer);
    this.reg?.destroy();
    this.reg = null;
  }
  private store(r: RoomInfo) {
    this.rooms.set(r.code, { ...r, t: Date.now() });
  }
  private live() {
    const now = Date.now();
    for (const [k, r] of this.rooms) if (now - (r.t ?? 0) > 25000) this.rooms.delete(k);
    return [...this.rooms.values()];
  }
  private claim(): Promise<void> {
    return new Promise((res) => {
      const p = new Peer(LOBBY_ID, peerOptions());
      const done = () => res();
      p.on('open', () => {
        this.reg = p;
        p.on('connection', (c) => {
          c.on('data', (d: any) => {
            const m = typeof d === 'string' ? JSON.parse(d) : d;
            if (m.t === 'room') this.store(m.room);
            if (m.t === 'list') c.send({ t: 'rooms', rooms: this.live() });
          });
        });
        done();
      });
      p.on('error', () => {
        p.destroy();
        done();
      });
      setTimeout(done, 5000);
    });
  }
  /** send one announcement to the registry (true if someone answered the connection) */
  private post(r: RoomInfo): Promise<boolean> {
    if (this.reg) return Promise.resolve(true);
    return query((c) => c.send({ t: 'room', room: r }), 2500).then((ok) => ok !== null);
  }
  /** the browser: ask the registry for the room list ([] if there is no registry) */
  static list(): Promise<RoomInfo[]> {
    return new Promise((res) => {
      let done = false;
      query((c) => {
        c.on('data', (d: any) => {
          const m = typeof d === 'string' ? JSON.parse(d) : d;
          if (m.t === 'rooms' && !done) {
            done = true;
            res(m.rooms as RoomInfo[]);
          }
        });
        c.send({ t: 'list' });
      }, 5000).then((ok) => {
        if (!done && ok === null) res([]);
      });
      setTimeout(() => {
        if (!done) {
          done = true;
          res([]);
        }
      }, 6000);
    });
  }
}
/** open a short-lived connection to the registry peer */
function query(use: (c: DataConnection) => void, timeout: number): Promise<true | null> {
  return new Promise((res) => {
    const p = new Peer(peerOptions());
    let settled = false;
    const end = (v: true | null) => {
      if (settled) return;
      settled = true;
      res(v);
      setTimeout(() => p.destroy(), 1500);
    };
    p.on('open', () => {
      const c = p.connect(LOBBY_ID, { reliable: true, serialization: 'json', label: 'lobby' });
      c.on('open', () => {
        use(c);
        end(true);
      });
      c.on('error', () => end(null));
    });
    p.on('error', () => end(null));
    setTimeout(() => end(null), timeout);
  });
}
