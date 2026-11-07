import Peer, { DataConnection } from 'peerjs';

/**
 * Peer-to-peer transport (WebRTC data channels via PeerJS). One player hosts and gets a short
 * room code; everyone else connects straight to the host. The PeerJS cloud broker is only used to
 * introduce the browsers to each other (no game traffic goes through it). For tests a local broker
 * can be used with `?peer=host:port`.
 */
export type NetMsg = { t: string; [k: string]: unknown };

const PREFIX = 'fjordfront-v1-';
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  return s;
}
export function cleanCode(c: string) {
  return c.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

import type { PeerOptions } from 'peerjs';
function peerOptions(): PeerOptions {
  const q = new URLSearchParams(location.search).get('peer');
  if (q) {
    const [host, port] = q.split(':');
    return { host, port: +(port || 9000), path: '/', secure: false, debug: 1 };
  }
  return { debug: 1 };
}

export class Net {
  peer: Peer | null = null;
  role: 'off' | 'host' | 'client' = 'off';
  code = '';
  /** host: open connections by peer id */
  conns = new Map<string, DataConnection>();
  /** client: the connection to the host */
  hostConn: DataConnection | null = null;
  onMessage: (from: string, m: NetMsg) => void = () => {};
  onPeerLeave: (id: string) => void = () => {};
  onPeerJoin: (id: string) => void = () => {};
  onClosed: (why: string) => void = () => {};
  /** bytes sent / received in the last second (for /net) */
  stats = { up: 0, down: 0, _up: 0, _down: 0, t: 0 };

  get myId() {
    return this.peer?.id ?? '';
  }

  host(code = makeCode()): Promise<string> {
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
      p.on('error', (e: Error & { type?: string }) => {
        if (!opened) {
          // the code is taken: try another
          if (e.type === 'unavailable-id') this.host().then(resolve, reject);
          else reject(new Error(this.describe(e)));
        } else console.warn('[net]', e.type, e.message);
      });
      p.on('disconnected', () => {
        // lost the broker: existing games keep running, new joins need it back
        if (this.role === 'host') p.reconnect();
      });
    });
  }

  join(code: string, hello: NetMsg): Promise<void> {
    this.close();
    code = cleanCode(code);
    return new Promise((resolve, reject) => {
      const p = new Peer(peerOptions());
      this.peer = p;
      const fail = (why: string) => {
        reject(new Error(why));
        this.close();
      };
      const timer = setTimeout(() => fail('No answer from that room. Check the code, and that the host is still in the game.'), 15000);
      p.on('open', () => {
        const c = p.connect(PREFIX + code, { reliable: true, serialization: 'json' });
        this.hostConn = c;
        c.on('open', () => {
          clearTimeout(timer);
          this.role = 'client';
          this.code = code;
          this.wire(c, 'host');
          c.send(hello);
          resolve();
        });
        c.on('error', (e) => fail('Connection failed: ' + e.message));
      });
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

  private accept(c: DataConnection) {
    c.on('open', () => {
      this.conns.set(c.peer, c);
      this.wire(c, c.peer);
      this.onPeerJoin(c.peer);
    });
  }

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
        this.onPeerLeave(c.peer);
      } else if (this.role === 'client') {
        this.role = 'off';
        this.onClosed('The host left the game.');
      }
    });
  }

  /** client → host, or host → one peer */
  send(m: NetMsg, to?: string) {
    const c = this.role === 'client' ? this.hostConn : to ? this.conns.get(to) : null;
    if (!c || !c.open) return;
    const s = JSON.stringify(m);
    this.stats._up += s.length;
    c.send(s);
  }
  /** host → every client (optionally except one) */
  broadcast(m: NetMsg, except?: string) {
    if (this.role !== 'host') return;
    const s = JSON.stringify(m);
    for (const [id, c] of this.conns) {
      if (id === except || !c.open) continue;
      this.stats._up += s.length;
      c.send(s);
    }
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

  close() {
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
    this.hostConn?.close();
    this.hostConn = null;
    const p = this.peer;
    this.peer = null;
    this.role = 'off';
    this.code = '';
    if (p && !p.destroyed) p.destroy();
  }
}
