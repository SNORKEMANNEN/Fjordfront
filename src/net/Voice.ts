import type { MediaConnection, Peer } from 'peerjs';

/**
 * Voice chat: WebRTC audio straight between players (a mesh — every pair that both have voice on
 * holds one call; the lower slot rings the higher one). Push-to-talk or open mic; team channel
 * (only your side hears you) or proximity (everyone near you, fading with distance). Each remote
 * voice runs through its own gain node, so muting a player or the channel / distance rules are just
 * a volume, and an analyser per voice lights the speaking indicator.
 */
export interface VoiceLink {
  call: MediaConnection;
  slot: number;
  audio: HTMLAudioElement | null;
  gain: GainNode | null;
  an: AnalyserNode | null;
  level: number;
}

export class Voice {
  stream: MediaStream | null = null;
  links = new Map<string, VoiceLink>();
  /** slots heard speaking right now */
  speaking = new Set<number>();
  /** this player's mic is open (push-to-talk held, or open mic with voice above the gate) */
  talking = false;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buf = new Uint8Array(256);
  private myAn: AnalyserNode | null = null;
  error = '';

  get on() {
    return !!this.stream;
  }

  async enable() {
    if (this.stream) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      this.ensureCtx();
      // my own level (open-mic gate + "you are talking" indicator)
      const src = this.ctx!.createMediaStreamSource(this.stream);
      this.myAn = this.ctx!.createAnalyser();
      this.myAn.fftSize = 256;
      src.connect(this.myAn);
      this.setMic(false);
      this.error = '';
      return true;
    } catch (e) {
      this.error = (e as Error).name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the browser address bar.' : 'No microphone found.';
      this.stream = null;
      return false;
    }
  }
  disable() {
    this.closeAll();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.myAn = null;
    this.talking = false;
  }
  private ensureCtx() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
  }
  setVolume(v: number) {
    if (this.master) this.master.gain.value = v;
  }
  /** open / close the microphone track */
  setMic(open: boolean) {
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = open));
  }

  /** ring another player */
  call(peer: Peer, pid: string, slot: number, mySlot: number) {
    if (!this.stream || this.links.has(pid)) return;
    try {
      const c = peer.call(pid, this.stream, { metadata: { slot: mySlot } });
      if (c) this.attach(c, slot);
    } catch (e) {
      console.warn('[voice] call failed', e);
    }
  }
  /** someone rings: answer when voice is on */
  incoming(c: MediaConnection) {
    if (!this.stream) {
      c.close();
      return;
    }
    const slot = Number((c.metadata as { slot?: number } | undefined)?.slot ?? -1);
    this.links.get(c.peer)?.call.close();
    c.answer(this.stream);
    this.attach(c, slot);
  }
  private attach(c: MediaConnection, slot: number) {
    const l: VoiceLink = { call: c, slot, audio: null, gain: null, an: null, level: 0 };
    this.links.set(c.peer, l);
    c.on('stream', (remote) => {
      this.ensureCtx();
      if (this.ctx!.state === 'suspended') this.ctx!.resume().catch(() => {});
      // Chrome only feeds a remote WebRTC stream into Web Audio while a media element plays it
      const a = new Audio();
      a.muted = true;
      a.srcObject = remote;
      a.play().catch(() => {});
      const src = this.ctx!.createMediaStreamSource(remote);
      const an = this.ctx!.createAnalyser();
      an.fftSize = 256;
      const g = this.ctx!.createGain();
      src.connect(an);
      an.connect(g);
      g.connect(this.master!);
      l.audio = a;
      l.gain = g;
      l.an = an;
    });
    const drop = () => {
      if (this.links.get(c.peer) === l) this.links.delete(c.peer);
      l.gain?.disconnect();
      if (l.audio) l.audio.srcObject = null;
    };
    c.on('close', drop);
    c.on('error', drop);
  }
  hangUp(pid: string) {
    this.links.get(pid)?.call.close();
    this.links.delete(pid);
  }
  closeAll() {
    for (const l of this.links.values()) l.call.close();
    this.links.clear();
    this.speaking.clear();
  }

  private level(an: AnalyserNode) {
    an.getByteTimeDomainData(this.buf);
    let m = 0;
    for (let i = 0; i < this.buf.length; i++) m = Math.max(m, Math.abs(this.buf[i] - 128));
    return m / 128;
  }
  /**
   * Per frame: `gainFor(slot)` is the volume each voice should have (0 = muted / out of range /
   * other channel); `ptt` = push-to-talk held (null = open mic).
   */
  update(dt: number, gainFor: (slot: number) => number, ptt: boolean | null) {
    if (!this.stream) return;
    if (ptt !== null) {
      this.talking = ptt;
      this.setMic(ptt);
    } else {
      // open mic with a simple gate so the channel is not a constant hiss
      const lv = this.myAn ? this.level(this.myAn) : 0;
      if (lv > 0.06) this.gateT = 0.4;
      this.gateT -= dt;
      this.talking = this.gateT > 0;
      this.setMic(this.talking);
    }
    this.speaking.clear();
    for (const l of this.links.values()) {
      if (!l.gain || !l.an) continue;
      const g = gainFor(l.slot);
      l.gain.gain.value += (g - l.gain.gain.value) * Math.min(1, dt * 10);
      l.level = this.level(l.an);
      if (l.level > 0.04 && g > 0.02) this.speaking.add(l.slot);
    }
  }
  private gateT = 0;
}
