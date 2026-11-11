import * as THREE from 'three';
import { Music } from './Music';
import { Settings } from '../game/Settings';
import { WeaponDef, WEAPONS } from '../weapons/WeaponDefs';

/**
 * Procedural audio engine. Every sound is synthesised at load time with an
 * OfflineAudioContext (no external samples), then played through HRTF panners
 * with distance filtering, speed-of-sound delay and an outdoor/indoor reverb send.
 */
type Bank = Record<string, AudioBuffer[]>;
const SR = 44100;

function noiseBuffer(ctx: BaseAudioContext, dur: number, color: 'white' | 'pink' | 'brown' = 'white') {
  const n = Math.floor(dur * ctx.sampleRate);
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  let l = 0, b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (color === 'white') d[i] = w;
    else if (color === 'brown') {
      l = (l + 0.02 * w) / 1.02;
      d[i] = l * 3.5;
    } else {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
  }
  return b;
}

async function render(dur: number, build: (ctx: OfflineAudioContext, out: AudioNode) => void, channels = 1): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(channels, Math.ceil(dur * SR), SR);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -6;
  comp.ratio.value = 4;
  comp.attack.value = 0.001;
  comp.release.value = 0.08;
  comp.connect(ctx.destination);
  build(ctx, comp);
  return ctx.startRendering();
}

/** Noise burst with envelope through a filter chain. */
function burst(ctx: BaseAudioContext, out: AudioNode, t: number, opts: { dur: number; attack?: number; decay: number; gain: number; type?: BiquadFilterType; freq?: number; q?: number; freqEnd?: number; color?: 'white' | 'pink' | 'brown'; hp?: number }) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, opts.dur + 0.05, opts.color ?? 'white');
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.gain, t + (opts.attack ?? 0.001));
  g.gain.exponentialRampToValueAtTime(0.0001, t + (opts.attack ?? 0.001) + opts.decay);
  let node: AudioNode = src;
  if (opts.type) {
    const f = ctx.createBiquadFilter();
    f.type = opts.type;
    f.frequency.setValueAtTime(opts.freq ?? 1000, t);
    if (opts.freqEnd) f.frequency.exponentialRampToValueAtTime(opts.freqEnd, t + opts.dur);
    f.Q.value = opts.q ?? 0.7;
    node.connect(f);
    node = f;
  }
  if (opts.hp) {
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = opts.hp;
    node.connect(f);
    node = f;
  }
  node.connect(g).connect(out);
  src.start(t);
  src.stop(t + opts.dur + 0.05);
}

function tone(ctx: BaseAudioContext, out: AudioNode, t: number, f0: number, f1: number, dur: number, gain: number, type: OscillatorType = 'sine', decay = dur) {
  if (f0 > ctx.sampleRate * 0.45) return;
  f1 = Math.min(f1, ctx.sampleRate * 0.45);
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + decay + 0.02);
}

function metal(ctx: BaseAudioContext, out: AudioNode, t: number, base: number, gain: number, decay: number) {
  for (const [r, a] of [[1, 1], [2.76, 0.6], [5.4, 0.35], [8.9, 0.2]] as const) tone(ctx, out, t, base * r, base * r * 0.995, decay, gain * a, 'sine', decay / Math.sqrt(r));
  burst(ctx, out, t, { dur: 0.02, decay: 0.015, gain: gain * 0.8, type: 'highpass', freq: 3000 });
}

// ---------------------------------------------------------------- designs
async function gunshot(def: WeaponDef, distant: boolean, variant: number): Promise<AudioBuffer> {
  const s = def.sound;
  const p = s.pitch * (1 + (variant - 1) * 0.04);
  return render(distant ? 3.2 : 2.2, (ctx, out) => {
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
    }
    shaper.curve = curve;
    const bus = ctx.createGain();
    bus.gain.value = 0.9;
    bus.connect(shaper).connect(out);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = distant ? 900 : 16000;
    lp.connect(bus);
    const t = 0.005 + (distant ? 0.0 : 0);
    if (s.suppressed) {
      burst(ctx, lp, t, { dur: 0.09, decay: 0.07, gain: 0.55 * s.body, type: 'bandpass', freq: 1400 * p, q: 0.8 });
      tone(ctx, lp, t, 110 * p, 50, 0.08, 0.4, 'sine');
      metal(ctx, lp, t + 0.012, 1900 * p, 0.12, 0.08); // action
      burst(ctx, lp, t + 0.01, { dur: 0.3, decay: 0.25, gain: 0.07, type: 'lowpass', freq: 1200, color: 'pink' });
      return;
    }
    // supersonic crack
    if (!distant) burst(ctx, lp, t, { dur: 0.006, attack: 0.0003, decay: 0.004, gain: 1.0 * s.crack, type: 'highpass', freq: 2500 });
    // muzzle blast
    burst(ctx, lp, t, { dur: 0.2, attack: 0.0008, decay: 0.09 * s.body + 0.03, gain: 1.0 * s.body, type: 'lowpass', freq: 5200 * p, freqEnd: 700, color: 'white' });
    burst(ctx, lp, t, { dur: 0.25, attack: 0.001, decay: 0.16 * s.body, gain: 0.7 * s.body, type: 'bandpass', freq: 650 * p, q: 0.9, color: 'pink' });
    // low body
    tone(ctx, lp, t, 95 * p * (1 + s.low * 0.1), 38, 0.18 * s.low + 0.05, 0.95 * s.low, 'sine', 0.22 * s.low + 0.06);
    tone(ctx, lp, t, 180 * p, 70, 0.06, 0.35 * s.low, 'triangle');
    // action
    if (!distant) metal(ctx, lp, t + 0.018 + variant * 0.002, 2300 * p, 0.09, 0.07);
    // tail: valley reverberation + mountain echoes
    const tail = s.tail * (distant ? 1.4 : 1);
    burst(ctx, lp, t + 0.02, { dur: 1.6, attack: 0.03, decay: 1.1 * tail, gain: 0.22 * tail, type: 'lowpass', freq: 1800, freqEnd: 260, color: 'pink' });
    for (const [dl, g, f] of [[0.34, 0.26, 900], [0.78, 0.17, 600], [1.35, 0.1, 420], [2.1, 0.05, 300]] as const) {
      burst(ctx, lp, t + dl, { dur: 0.5, attack: 0.012, decay: 0.32, gain: g * tail, type: 'lowpass', freq: f, color: 'pink' });
      tone(ctx, lp, t + dl, 70, 40, 0.2, g * 0.6 * s.low, 'sine', 0.3);
    }
  });
}

async function footstep(surface: string, v: number): Promise<AudioBuffer> {
  return render(0.4, (ctx, out) => {
    const t = 0.002;
    const r = 1 + (v - 1.5) * 0.07;
    switch (surface) {
      case 'grass':
        for (let i = 0; i < 6; i++) burst(ctx, out, t + i * 0.008 + Math.random() * 0.01, { dur: 0.05, decay: 0.035, gain: 0.25, type: 'bandpass', freq: 2200 * r, q: 0.6 });
        burst(ctx, out, t, { dur: 0.1, decay: 0.07, gain: 0.35, type: 'lowpass', freq: 600 * r, color: 'pink' });
        break;
      case 'dirt':
      case 'sand':
        burst(ctx, out, t, { dur: 0.12, decay: 0.08, gain: 0.5, type: 'lowpass', freq: 900 * r, color: 'pink' });
        for (let i = 0; i < 4; i++) burst(ctx, out, t + Math.random() * 0.03, { dur: 0.03, decay: 0.02, gain: 0.15, type: 'bandpass', freq: 3000, q: 1 });
        break;
      case 'gravel':
        for (let i = 0; i < 14; i++) burst(ctx, out, t + Math.random() * 0.06, { dur: 0.015, decay: 0.012, gain: 0.25, type: 'bandpass', freq: 2500 + Math.random() * 3000, q: 2 });
        burst(ctx, out, t, { dur: 0.1, decay: 0.06, gain: 0.3, type: 'lowpass', freq: 700, color: 'pink' });
        break;
      case 'wood':
        tone(ctx, out, t, 180 * r, 140, 0.12, 0.45, 'sine', 0.14);
        tone(ctx, out, t, 420 * r, 380, 0.06, 0.2, 'triangle', 0.08);
        burst(ctx, out, t, { dur: 0.05, decay: 0.03, gain: 0.3, type: 'bandpass', freq: 1200 * r, q: 1.5 });
        break;
      case 'metal':
        metal(ctx, out, t, 420 * r, 0.12, 0.28);
        burst(ctx, out, t, { dur: 0.05, decay: 0.03, gain: 0.35, type: 'lowpass', freq: 1200 });
        break;
      case 'water':
        burst(ctx, out, t, { dur: 0.25, decay: 0.18, gain: 0.45, type: 'bandpass', freq: 900, freqEnd: 2400, q: 0.8 });
        burst(ctx, out, t + 0.04, { dur: 0.2, decay: 0.15, gain: 0.2, type: 'highpass', freq: 3000 });
        break;
      default: // concrete / rock / asphalt
        burst(ctx, out, t, { dur: 0.06, decay: 0.04, gain: 0.55, type: 'lowpass', freq: 1500 * r });
        tone(ctx, out, t, 120 * r, 80, 0.05, 0.3, 'sine', 0.06);
        burst(ctx, out, t + 0.012, { dur: 0.06, decay: 0.05, gain: 0.12, type: 'highpass', freq: 4000 });
    }
  });
}

async function impact(surface: string): Promise<AudioBuffer> {
  return render(0.7, (ctx, out) => {
    const t = 0.002;
    switch (surface) {
      case 'metal':
        metal(ctx, out, t, 900 + Math.random() * 600, 0.35, 0.45);
        burst(ctx, out, t, { dur: 0.04, decay: 0.02, gain: 0.6, type: 'highpass', freq: 2000 });
        break;
      case 'wood':
        tone(ctx, out, t, 260, 160, 0.1, 0.6, 'triangle', 0.12);
        burst(ctx, out, t, { dur: 0.15, decay: 0.1, gain: 0.6, type: 'bandpass', freq: 1500, q: 0.8 });
        break;
      case 'glass':
        for (let i = 0; i < 22; i++) tone(ctx, out, t + Math.random() * 0.25, 3000 + Math.random() * 5000, 2500, 0.08, 0.08, 'sine', 0.06 + Math.random() * 0.1);
        burst(ctx, out, t, { dur: 0.35, decay: 0.3, gain: 0.5, type: 'highpass', freq: 2500 });
        break;
      case 'flesh':
        burst(ctx, out, t, { dur: 0.08, decay: 0.05, gain: 0.8, type: 'lowpass', freq: 500, color: 'pink' });
        tone(ctx, out, t, 140, 60, 0.07, 0.6, 'sine');
        break;
      case 'water':
        burst(ctx, out, t, { dur: 0.35, decay: 0.25, gain: 0.5, type: 'bandpass', freq: 700, freqEnd: 2600, q: 0.7 });
        break;
      case 'grass':
      case 'dirt':
      case 'sand':
        burst(ctx, out, t, { dur: 0.12, decay: 0.08, gain: 0.7, type: 'lowpass', freq: 800, color: 'pink' });
        for (let i = 0; i < 6; i++) burst(ctx, out, t + Math.random() * 0.05, { dur: 0.02, decay: 0.015, gain: 0.15, type: 'bandpass', freq: 2500, q: 1 });
        break;
      default:
        burst(ctx, out, t, { dur: 0.05, attack: 0.0005, decay: 0.03, gain: 0.9, type: 'highpass', freq: 1800 });
        burst(ctx, out, t, { dur: 0.12, decay: 0.07, gain: 0.5, type: 'bandpass', freq: 900, q: 1 });
        for (let i = 0; i < 5; i++) burst(ctx, out, t + 0.02 + Math.random() * 0.12, { dur: 0.015, decay: 0.01, gain: 0.1, type: 'bandpass', freq: 3500, q: 2 });
    }
  });
}

async function mech(kind: string): Promise<AudioBuffer> {
  const LEN: Record<string, number> = { smokeHiss: 7, snapPulse: 1.6, servo: 0.9, zap: 0.8, trophyDeploy: 1.0, carFire: 3, debris: 1.2, bipod: 0.4, fireIgnite: 1.4 };
  return render(LEN[kind] ?? 0.6, (ctx, out) => {
    const t = 0.002;
    switch (kind) {
      // ---- Update 20 equipment ----
      case 'beep':
        tone(ctx, out, t, 2750, 2750, 0.07, 0.32, 'sine', 0.06);
        tone(ctx, out, t, 5500, 5500, 0.05, 0.06, 'sine', 0.04);
        break;
      case 'beepLow':
        tone(ctx, out, t, 1450, 1450, 0.09, 0.3, 'square', 0.08);
        break;
      case 'armChirp':
        tone(ctx, out, t, 1800, 3400, 0.12, 0.28, 'sine', 0.11);
        tone(ctx, out, t + 0.13, 3400, 3400, 0.06, 0.22, 'sine', 0.05);
        break;
      case 'clack':
        // detonator: a stiff plastic switch
        burst(ctx, out, t, { dur: 0.012, attack: 0.0003, decay: 0.008, gain: 0.9, type: 'bandpass', freq: 2400, q: 0.9 });
        tone(ctx, out, t, 900, 500, 0.03, 0.4, 'triangle', 0.02);
        burst(ctx, out, t + 0.035, { dur: 0.01, decay: 0.006, gain: 0.5, type: 'bandpass', freq: 3200, q: 1.2 });
        break;
      case 'stick':
        // wet, heavy slap of the adhesive
        burst(ctx, out, t, { dur: 0.08, attack: 0.001, decay: 0.05, gain: 0.9, type: 'lowpass', freq: 900, color: 'brown' });
        tone(ctx, out, t, 140, 70, 0.08, 0.6, 'sine', 0.06);
        burst(ctx, out, t + 0.01, { dur: 0.12, decay: 0.09, gain: 0.25, type: 'bandpass', freq: 2200, q: 2 });
        break;
      case 'legs':
        metal(ctx, out, t, 2100, 0.14, 0.05);
        burst(ctx, out, t, { dur: 0.015, decay: 0.01, gain: 0.5, type: 'highpass', freq: 3000 });
        break;
      case 'claymoreClick':
        metal(ctx, out, t, 3100, 0.2, 0.04);
        tone(ctx, out, t + 0.06, 2200, 2200, 0.08, 0.25, 'square', 0.07);
        break;
      case 'zap':
        // trophy intercept: a sharp electrical crack, a pop and a short sizzle
        burst(ctx, out, t, { dur: 0.03, attack: 0.0003, decay: 0.02, gain: 1.0, type: 'highpass', freq: 2500 });
        for (let i = 0; i < 6; i++) tone(ctx, out, t + i * 0.012, 1200 + Math.random() * 2400, 300, 0.03, 0.18, 'sawtooth', 0.025);
        burst(ctx, out, t + 0.05, { dur: 0.08, attack: 0.001, decay: 0.06, gain: 0.8, type: 'lowpass', freq: 1200, color: 'brown' });
        tone(ctx, out, t + 0.05, 180, 60, 0.12, 0.6, 'sine', 0.1);
        burst(ctx, out, t + 0.1, { dur: 0.6, attack: 0.01, decay: 0.45, gain: 0.18, type: 'highpass', freq: 4000 });
        break;
      case 'servo':
        tone(ctx, out, t, 420, 760, 0.45, 0.12, 'sawtooth', 0.42);
        tone(ctx, out, t, 840, 1520, 0.45, 0.05, 'square', 0.42);
        burst(ctx, out, t, { dur: 0.45, attack: 0.05, decay: 0.38, gain: 0.08, type: 'bandpass', freq: 1800, q: 3 });
        tone(ctx, out, t + 0.5, 1900, 1900, 0.08, 0.2, 'sine', 0.07);
        tone(ctx, out, t + 0.6, 2500, 2500, 0.08, 0.2, 'sine', 0.07);
        break;
      case 'trophyDeploy':
        // heavy set-down: thud, legs locking, then the spin-up
        tone(ctx, out, t, 110, 55, 0.18, 0.7, 'sine', 0.15);
        burst(ctx, out, t, { dur: 0.1, attack: 0.001, decay: 0.08, gain: 0.7, type: 'lowpass', freq: 700, color: 'brown' });
        metal(ctx, out, t + 0.12, 1700, 0.15, 0.06);
        metal(ctx, out, t + 0.17, 1850, 0.15, 0.06);
        metal(ctx, out, t + 0.21, 1600, 0.15, 0.06);
        tone(ctx, out, t + 0.3, 300, 1400, 0.55, 0.1, 'sawtooth', 0.5);
        break;
      case 'snapPulse':
        // snapshot: a deep whump and a bright sweep outward
        tone(ctx, out, t, 90, 40, 0.5, 0.8, 'sine', 0.45);
        burst(ctx, out, t, { dur: 0.15, attack: 0.002, decay: 0.12, gain: 0.6, type: 'lowpass', freq: 600, color: 'brown' });
        tone(ctx, out, t + 0.02, 600, 4200, 0.9, 0.14, 'sine', 0.85);
        tone(ctx, out, t + 0.02, 603, 4230, 0.9, 0.1, 'triangle', 0.85);
        burst(ctx, out, t + 0.05, { dur: 1.1, attack: 0.1, decay: 0.9, gain: 0.12, type: 'bandpass', freq: 3000, q: 4, freqEnd: 7000 });
        break;
      case 'bipod':
        metal(ctx, out, t, 1500, 0.2, 0.08);
        burst(ctx, out, t, { dur: 0.04, decay: 0.03, gain: 0.5, type: 'bandpass', freq: 1800, q: 1 });
        metal(ctx, out, t + 0.09, 1250, 0.25, 0.1);
        tone(ctx, out, t + 0.09, 160, 90, 0.08, 0.4, 'sine', 0.07);
        break;
      case 'debris':
        // wood / metal bits landing
        for (let i = 0; i < 9; i++) burst(ctx, out, t + Math.random() * 0.8, { dur: 0.04, decay: 0.03, gain: 0.2 + Math.random() * 0.3, type: 'bandpass', freq: 600 + Math.random() * 2400, q: 1.5 });
        break;
      case 'fireIgnite':
        burst(ctx, out, t, { dur: 1.2, attack: 0.02, decay: 1.0, gain: 0.7, type: 'lowpass', freq: 900, freqEnd: 400, color: 'brown' });
        burst(ctx, out, t, { dur: 0.6, attack: 0.01, decay: 0.5, gain: 0.3, type: 'bandpass', freq: 2500, q: 0.6 });
        break;
      case 'carFire':
        // crackling fire bed (looped while a vehicle burns)
        burst(ctx, out, 0, { dur: 3, attack: 0.001, decay: 3, gain: 0.25, type: 'lowpass', freq: 700, color: 'brown' });
        for (let i = 0; i < 70; i++) burst(ctx, out, Math.random() * 2.9, { dur: 0.02, decay: 0.012, gain: 0.15 + Math.random() * 0.4, type: 'bandpass', freq: 1500 + Math.random() * 4000, q: 1.2 });
        break;
      case 'magOut':
        metal(ctx, out, t, 1400, 0.1, 0.06);
        burst(ctx, out, t + 0.02, { dur: 0.12, decay: 0.09, gain: 0.35, type: 'bandpass', freq: 1800, q: 1.2 });
        tone(ctx, out, t + 0.03, 300, 200, 0.05, 0.15, 'triangle');
        break;
      case 'magTouch':
        burst(ctx, out, t, { dur: 0.06, decay: 0.04, gain: 0.25, type: 'bandpass', freq: 2500, q: 1.5 });
        break;
      case 'magIn':
        metal(ctx, out, t, 1100, 0.22, 0.08);
        burst(ctx, out, t, { dur: 0.05, attack: 0.0005, decay: 0.03, gain: 0.7, type: 'bandpass', freq: 2200, q: 1.0 });
        tone(ctx, out, t, 220, 120, 0.05, 0.35, 'sine');
        metal(ctx, out, t + 0.06, 1800, 0.08, 0.05);
        break;
      case 'boltRelease':
      case 'slideRelease':
      case 'boltClose':
        burst(ctx, out, t, { dur: 0.04, attack: 0.0005, decay: 0.025, gain: 0.8, type: 'highpass', freq: 1500 });
        metal(ctx, out, t, 1650, 0.25, 0.12);
        tone(ctx, out, t, 180, 90, 0.06, 0.4, 'sine');
        break;
      case 'boltOpen':
      case 'boltBack':
        burst(ctx, out, t, { dur: 0.12, decay: 0.08, gain: 0.4, type: 'bandpass', freq: 2600, q: 1.4 });
        metal(ctx, out, t + 0.05, 1300, 0.12, 0.08);
        break;
      case 'pumpBack':
        burst(ctx, out, t, { dur: 0.14, decay: 0.1, gain: 0.5, type: 'bandpass', freq: 1500, q: 1.1 });
        metal(ctx, out, t + 0.08, 900, 0.2, 0.1);
        break;
      case 'pumpForward':
        burst(ctx, out, t, { dur: 0.1, decay: 0.07, gain: 0.5, type: 'bandpass', freq: 1900, q: 1.1 });
        metal(ctx, out, t + 0.06, 1200, 0.3, 0.12);
        tone(ctx, out, t + 0.06, 200, 110, 0.06, 0.4, 'sine');
        break;
      case 'shellIn':
        burst(ctx, out, t, { dur: 0.06, decay: 0.04, gain: 0.4, type: 'bandpass', freq: 1300, q: 1.5 });
        metal(ctx, out, t + 0.03, 700, 0.12, 0.08);
        break;
      case 'dry':
        metal(ctx, out, t, 2600, 0.12, 0.04);
        burst(ctx, out, t, { dur: 0.02, decay: 0.012, gain: 0.4, type: 'highpass', freq: 3000 });
        break;
      case 'click':
        burst(ctx, out, t, { dur: 0.015, decay: 0.01, gain: 0.35, type: 'highpass', freq: 3500 });
        break;
      case 'cloth':
        burst(ctx, out, t, { dur: 0.35, attack: 0.05, decay: 0.25, gain: 0.18, type: 'bandpass', freq: 1800, q: 0.5, color: 'pink' });
        break;
      case 'rattle':
        for (let i = 0; i < 4; i++) metal(ctx, out, t + i * 0.05 + Math.random() * 0.02, 1500 + Math.random() * 800, 0.04, 0.04);
        break;
      case 'hit':
        // crisp tick + a little body: the MW-style "tk"
        burst(ctx, out, t, { dur: 0.006, attack: 0.0003, decay: 0.004, gain: 0.7, type: 'highpass', freq: 5000 });
        tone(ctx, out, t, 3600, 3300, 0.025, 0.22, 'sine', 0.03);
        tone(ctx, out, t, 170, 95, 0.05, 0.4, 'sine', 0.06);
        burst(ctx, out, t + 0.002, { dur: 0.04, decay: 0.03, gain: 0.25, type: 'lowpass', freq: 1400, color: 'pink' });
        break;
      case 'kill':
        // heavy thump followed by a bright two-note confirm
        tone(ctx, out, t, 130, 45, 0.14, 0.85, 'sine', 0.16);
        burst(ctx, out, t, { dur: 0.08, decay: 0.06, gain: 0.55, type: 'lowpass', freq: 900, color: 'pink' });
        burst(ctx, out, t, { dur: 0.006, attack: 0.0003, decay: 0.004, gain: 0.8, type: 'highpass', freq: 5000 });
        tone(ctx, out, t + 0.035, 1480, 1470, 0.08, 0.22, 'sine', 0.22);
        tone(ctx, out, t + 0.085, 2220, 2210, 0.1, 0.2, 'sine', 0.3);
        metal(ctx, out, t + 0.03, 3100, 0.05, 0.18);
        break;
      case 'elim':
        // elimination confirm layer: sub drop + snappy body + airy shimmer tail (sits under 'kill')
        tone(ctx, out, t, 72, 38, 0.32, 0.9, 'sine', 0.3);
        tone(ctx, out, t, 220, 110, 0.06, 0.35, 'triangle', 0.08);
        burst(ctx, out, t + 0.004, { dur: 0.05, attack: 0.001, decay: 0.04, gain: 0.35, type: 'bandpass', freq: 2400, q: 0.9 });
        for (let i = 0; i < 3; i++) tone(ctx, out, t + 0.06 + i * 0.012, 2960 + i * 740, 2950 + i * 740, 0.22, 0.05, 'sine', 0.35);
        burst(ctx, out, t + 0.05, { dur: 0.35, attack: 0.04, decay: 0.3, gain: 0.08, type: 'highpass', freq: 6000, color: 'pink' });
        break;
      case 'headshot':
        // helmet "dink"
        metal(ctx, out, t, 2700, 0.32, 0.32);
        tone(ctx, out, t, 4300, 4200, 0.05, 0.2, 'sine', 0.12);
        tone(ctx, out, t, 160, 80, 0.05, 0.35, 'sine', 0.07);
        break;
      case 'medal':
        tone(ctx, out, t, 880, 878, 0.3, 0.16, 'triangle', 0.35);
        tone(ctx, out, t + 0.07, 1320, 1318, 0.3, 0.14, 'triangle', 0.4);
        tone(ctx, out, t + 0.14, 1760, 1758, 0.35, 0.12, 'sine', 0.5);
        break;
      case 'adsIn':
        burst(ctx, out, t, { dur: 0.16, attack: 0.02, decay: 0.12, gain: 0.22, type: 'bandpass', freq: 1700, q: 0.6, color: 'pink' });
        metal(ctx, out, t + 0.05, 2200, 0.02, 0.04);
        break;
      case 'adsOut':
        burst(ctx, out, t, { dur: 0.12, attack: 0.015, decay: 0.09, gain: 0.16, type: 'bandpass', freq: 1300, q: 0.6, color: 'pink' });
        break;
      case 'breathIn':
        burst(ctx, out, t, { dur: 0.45, attack: 0.12, decay: 0.3, gain: 0.18, type: 'bandpass', freq: 900, q: 0.4, color: 'pink' });
        break;
      case 'breathOut':
        burst(ctx, out, t, { dur: 0.6, attack: 0.03, decay: 0.5, gain: 0.22, type: 'bandpass', freq: 600, freqEnd: 300, q: 0.5, color: 'pink' });
        break;
      case 'lowAmmo':
        metal(ctx, out, t, 4200, 0.06, 0.08);
        break;
      case 'whiz':
        burst(ctx, out, t, { dur: 0.25, attack: 0.08, decay: 0.15, gain: 0.5, type: 'bandpass', freq: 2500, freqEnd: 900, q: 3 });
        burst(ctx, out, t + 0.08, { dur: 0.01, decay: 0.006, gain: 0.7, type: 'highpass', freq: 3000 });
        break;
      case 'brass':
        metal(ctx, out, t, 3800 + Math.random() * 800, 0.08, 0.16);
        metal(ctx, out, t + 0.09, 4100, 0.04, 0.1);
        break;
      case 'jump':
        burst(ctx, out, t, { dur: 0.15, attack: 0.02, decay: 0.1, gain: 0.22, type: 'bandpass', freq: 1200, q: 0.6, color: 'pink' });
        break;
      case 'land':
        burst(ctx, out, t, { dur: 0.15, decay: 0.1, gain: 0.6, type: 'lowpass', freq: 700, color: 'pink' });
        tone(ctx, out, t, 90, 50, 0.1, 0.5, 'sine');
        metal(ctx, out, t + 0.02, 1700, 0.03, 0.05);
        break;
      case 'mantle':
        burst(ctx, out, t, { dur: 0.25, attack: 0.03, decay: 0.2, gain: 0.3, type: 'bandpass', freq: 900, q: 0.7, color: 'pink' });
        burst(ctx, out, t + 0.12, { dur: 0.08, decay: 0.05, gain: 0.25, type: 'lowpass', freq: 900 });
        break;
      case 'tac':
        burst(ctx, out, t, { dur: 0.3, attack: 0.04, decay: 0.22, gain: 0.25, type: 'bandpass', freq: 1500, q: 0.5, color: 'pink' });
        for (let i = 0; i < 3; i++) metal(ctx, out, t + i * 0.06, 1600 + i * 300, 0.025, 0.05);
        break;
      // ---- UI stings (interface sounds, not weapon audio) ----
      case 'flagWon':
        tone(ctx, out, t, 523, 523, 0.18, 0.2, 'triangle', 0.2);
        tone(ctx, out, t + 0.11, 784, 784, 0.2, 0.2, 'triangle', 0.25);
        tone(ctx, out, t + 0.22, 1046, 1046, 0.4, 0.18, 'sine', 0.45);
        tone(ctx, out, t, 130, 65, 0.2, 0.4, 'sine', 0.2);
        break;
      case 'flagLost':
        tone(ctx, out, t, 622, 620, 0.2, 0.2, 'triangle', 0.22);
        tone(ctx, out, t + 0.14, 466, 464, 0.45, 0.2, 'triangle', 0.5);
        tone(ctx, out, t, 110, 60, 0.25, 0.4, 'sine', 0.25);
        break;
      case 'capTick':
        tone(ctx, out, t, 1900, 1900, 0.03, 0.12, 'sine', 0.03);
        break;
      case 'streak':
        tone(ctx, out, t, 660, 660, 0.12, 0.18, 'square', 0.1);
        tone(ctx, out, t + 0.09, 990, 990, 0.12, 0.16, 'square', 0.1);
        tone(ctx, out, t + 0.18, 1320, 1320, 0.3, 0.16, 'sine', 0.3);
        break;
      case 'radio':
        burst(ctx, out, t, { dur: 0.08, decay: 0.06, gain: 0.35, type: 'bandpass', freq: 2200, q: 3 });
        tone(ctx, out, t + 0.06, 1200, 1200, 0.05, 0.12, 'square', 0.05);
        burst(ctx, out, t + 0.12, { dur: 0.25, decay: 0.2, gain: 0.12, type: 'bandpass', freq: 1800, q: 1.5 });
        break;
      case 'uavPing':
        tone(ctx, out, t, 1400, 1380, 0.4, 0.14, 'sine', 0.4);
        tone(ctx, out, t, 2800, 2780, 0.2, 0.05, 'sine', 0.2);
        break;
      case 'heartbeat':
        tone(ctx, out, t, 62, 40, 0.11, 0.9, 'sine', 0.1);
        tone(ctx, out, t + 0.17, 55, 36, 0.12, 0.65, 'sine', 0.12);
        break;
      case 'whistle':
        // incoming mortar round: falling whistle
        tone(ctx, out, t, 1500, 520, 0.55, 0.12, 'sine', 0.55);
        burst(ctx, out, t, { dur: 0.55, attack: 0.2, decay: 0.35, gain: 0.08, type: 'bandpass', freq: 1200, freqEnd: 500, q: 4 });
        break;
      case 'swish':
        burst(ctx, out, t, { dur: 0.18, attack: 0.04, decay: 0.12, gain: 0.45, type: 'bandpass', freq: 900, freqEnd: 2600, q: 1.2, color: 'pink' });
        break;
      case 'smokeHiss':
        burst(ctx, out, t, { dur: 6.5, attack: 0.15, decay: 6.0, gain: 0.32, type: 'bandpass', freq: 2600, freqEnd: 1400, q: 0.5 });
        burst(ctx, out, t, { dur: 6.5, attack: 0.4, decay: 6.0, gain: 0.18, type: 'lowpass', freq: 700, color: 'pink' });
        break;
      case 'stimHiss':
        burst(ctx, out, t, { dur: 0.5, attack: 0.02, decay: 0.45, gain: 0.3, type: 'bandpass', freq: 3500, freqEnd: 2200, q: 0.8 });
        break;
      case 'pin':
        metal(ctx, out, t, 3400, 0.06, 0.07);
        metal(ctx, out, t + 0.09, 2600, 0.05, 0.12);
        break;
    }
  });
}

async function loopBuffer(kind: 'wind' | 'waves' | 'rain' | 'slide' | 'heli' | 'snowwind'): Promise<AudioBuffer> {
  if (kind === 'heli') {
    // rotor: amplitude-modulated low noise at the blade-pass rate + turbine whine
    return render(2, (ctx, out) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx, 2, 'brown');
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 380;
      const g = ctx.createGain();
      g.gain.value = 0;
      for (let t = 0; t < 2; t += 1 / 12) {
        g.gain.setValueAtTime(0.15, t);
        g.gain.linearRampToValueAtTime(0.95, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.15, t + 1 / 12 - 0.002);
      }
      src.connect(f).connect(g).connect(out);
      src.start(0);
      const o = ctx.createOscillator();
      o.frequency.value = 2250;
      const og = ctx.createGain();
      og.gain.value = 0.015;
      o.connect(og).connect(out);
      o.start(0);
    }, 1);
  }
  const dur = kind === 'slide' ? 2 : 12;
  return render(dur, (ctx, out) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, dur, kind === 'wind' || kind === 'waves' ? 'pink' : 'white');
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    if (kind === 'snowwind') {
      // cold gusts: higher, thinner, slower swells
      f.type = 'bandpass';
      f.Q.value = 1.1;
      for (let i = 0; i <= 12; i++) {
        f.frequency.setValueAtTime(600 + Math.random() * 900, i);
        g.gain.linearRampToValueAtTime(0.15 + Math.random() * 0.45, i);
      }
    } else if (kind === 'wind') {
      f.type = 'bandpass';
      f.Q.value = 0.6;
      for (let i = 0; i <= 12; i++) {
        f.frequency.setValueAtTime(250 + Math.random() * 500, i);
        g.gain.setValueAtTime(0.25 + Math.random() * 0.35, i);
      }
      g.gain.setValueAtTime(0.3, 0);
      g.gain.setValueAtTime(0.3, dur);
    } else if (kind === 'waves') {
      f.type = 'lowpass';
      f.frequency.value = 900;
      g.gain.setValueAtTime(0.05, 0);
      for (let t = 0; t < dur; t += 3) {
        g.gain.linearRampToValueAtTime(0.55, t + 1.2);
        g.gain.linearRampToValueAtTime(0.08, t + 3);
      }
    } else if (kind === 'rain') {
      f.type = 'highpass';
      f.frequency.value = 1400;
      g.gain.value = 0.25;
    } else {
      f.type = 'bandpass';
      f.frequency.value = 900;
      f.Q.value = 0.5;
      g.gain.value = 0.6;
    }
    src.connect(f).connect(g).connect(out);
    src.start(0);
  }, 1);
}

async function bird(kind: 'gull' | 'song'): Promise<AudioBuffer> {
  return render(kind === 'gull' ? 1.6 : 1.2, (ctx, out) => {
    if (kind === 'gull') {
      for (let i = 0; i < 3; i++) {
        const t = i * 0.42;
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(1500, t);
        o.frequency.exponentialRampToValueAtTime(900, t + 0.3);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1800;
        bp.Q.value = 2;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.04);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
        o.connect(bp).connect(g).connect(out);
        o.start(t);
        o.stop(t + 0.36);
      }
    } else {
      let t = 0.01;
      for (let i = 0; i < 7; i++) {
        const f0 = 3000 + Math.random() * 2500;
        tone(ctx, out, t, f0, f0 * (0.7 + Math.random() * 0.6), 0.07, 0.12, 'sine', 0.08);
        t += 0.09 + Math.random() * 0.06;
      }
    }
  });
}

/** Generates an outdoor impulse response: dense early field + discrete mountain slaps. */
/** Room impulse responses: outdoor (valley echoes), small room, large hall (warehouse), tunnel (long flutter). */
function roomImpulse(ctx: AudioContext, kind: 'small' | 'hall' | 'tunnel') {
  const dur = kind === 'small' ? 0.6 : kind === 'hall' ? 2.2 : 2.8;
  const n = Math.floor(dur * ctx.sampleRate);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      const decay = kind === 'small' ? 10 : kind === 'hall' ? 2.6 : 2.0;
      const w = Math.random() * 2 - 1;
      // halls/tunnels: brighter metallic tail, small rooms: damped
      const k = kind === 'small' ? 0.35 : kind === 'hall' ? 0.75 : 0.55;
      lp = lp + (w - lp) * k;
      d[i] = lp * Math.exp(-t * decay) * (kind === 'small' ? 1.2 : 0.8);
    }
    if (kind === 'tunnel') {
      // flutter echo between the tunnel walls
      for (let e = 1; e < 14; e++) {
        const s = Math.floor((e * 0.058 + c * 0.004) * ctx.sampleRate);
        for (let i = 0; i < 600 && s + i < n; i++) d[s + i] += (Math.random() * 2 - 1) * 0.5 * Math.exp(-e * 0.22) * Math.exp(-i / 160);
      }
    }
    if (kind === 'hall') {
      for (const [dl, g] of [[0.045, 0.5], [0.09, 0.35], [0.16, 0.25]]) {
        const s = Math.floor((dl + c * 0.006) * ctx.sampleRate);
        for (let i = 0; i < 800 && s + i < n; i++) d[s + i] += (Math.random() * 2 - 1) * g * Math.exp(-i / 220);
      }
    }
  }
  return b;
}

export type RoomMix = { outdoor: number; small: number; hall: number; tunnel: number };

function impulse(ctx: AudioContext, indoor: boolean) {
  const dur = indoor ? 0.9 : 2.8;
  const n = Math.floor(dur * ctx.sampleRate);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      const env = indoor ? Math.exp(-t * 7) : Math.exp(-t * 2.4) * 0.6;
      d[i] = (Math.random() * 2 - 1) * env;
    }
    if (!indoor) {
      for (const [dl, g] of [[0.32, 0.5], [0.71, 0.35], [1.25, 0.22], [1.9, 0.12]]) {
        const s = Math.floor((dl + c * 0.013) * ctx.sampleRate);
        for (let i = 0; i < 2400 && s + i < n; i++) d[s + i] += (Math.random() * 2 - 1) * g * Math.exp(-i / 500);
      }
    }
  }
  return b;
}

export class AudioEngine {
  ctx: AudioContext;
  master: GainNode;
  sfx: GainNode;
  amb: GainNode;
  ui: GainNode;
  private reverbOut!: ConvolverNode;
  private reverbIn!: ConvolverNode;
  private revOutGain!: GainNode;
  private revInGain!: GainNode;
  private rooms!: Record<'small' | 'hall' | 'tunnel', { conv: ConvolverNode; gain: GainNode }>;
  private revBus: GainNode;
  room: RoomMix = { outdoor: 1, small: 0, hall: 0, tunnel: 0 };
  bank: Bank = {};
  ready = false;
  private loops: Record<string, { src: AudioBufferSourceNode; gain: GainNode; panner?: PannerNode }> = {};
  private listenerPos = new THREE.Vector3();
  private tmpL = new THREE.Vector3();
  indoor = 0;
  private birdT = 3;
  private muffle!: BiquadFilterNode;
  private ring!: GainNode;
  /** 0..1 ear ringing after a close explosion */
  tinnitus = 0;
  /** 0..1 low-health muffle */
  hurt = 0;
  /** subtitle text per voice key and variant */
  voiceText: Record<string, string[]> = {};
  /** 0..1 gustiness (from the weather) */
  windGust = 0;
  music: Music;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.sfx = this.ctx.createGain();
    this.amb = this.ctx.createGain();
    this.ui = this.ctx.createGain();
    this.sfx.connect(this.master);
    this.amb.connect(this.master);
    this.ui.connect(this.master);
    this.revBus = this.ctx.createGain();
    this.irs = { out: impulse(this.ctx, false), in: impulse(this.ctx, true), small: roomImpulse(this.ctx, 'small'), hall: roomImpulse(this.ctx, 'hall'), tunnel: roomImpulse(this.ctx, 'tunnel') };
    this.rebuildChain();
    this.music = new Music(this.ctx);
    this.applyVolumes();
    Settings.onChange(() => this.applyVolumes());
  }

  private irs: Record<'out' | 'in' | 'small' | 'hall' | 'tunnel', AudioBuffer>;
  private comp: DynamicsCompressorNode | null = null;

  /** (Re)build the stateful part of the mix: bus compressor/limiter and the convolution reverbs. */
  private rebuildChain() {
    const old = [this.comp, this.reverbOut, this.reverbIn, this.revOutGain, this.revInGain, ...(this.echo ? Object.values(this.echo) : []), ...(this.rooms ? Object.values(this.rooms).flatMap((r) => [r.conv, r.gain]) : [])];
    for (const n of old) {
      try { n?.disconnect(); } catch { /* ignore */ }
    }
    try { this.master.disconnect(); } catch { /* ignore */ }
    try { this.revBus.disconnect(); } catch { /* ignore */ }
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -9;
    comp.knee.value = 6;
    comp.ratio.value = 10;
    comp.attack.value = 0.0015;
    comp.release.value = 0.16;
    comp.connect(this.ctx.destination);
    this.comp = comp;
    // damage feedback: the whole mix closes in (low-pass) after nearby blasts and at low health
    try { this.muffle?.disconnect(); } catch { /* ignore */ }
    this.muffle = this.ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.muffle.Q.value = 0.5;
    this.master.connect(this.muffle).connect(comp);
    // tinnitus ring (bypasses the muffle on purpose)
    try { this.ring?.disconnect(); } catch { /* ignore */ }
    const osc = this.ctx.createOscillator();
    osc.frequency.value = 3950;
    this.ring = this.ctx.createGain();
    this.ring.gain.value = 0;
    osc.connect(this.ring).connect(comp);
    osc.start();
    this.probe = this.ctx.createAnalyser();
    this.probe.fftSize = 256;
    this.master.connect(this.probe);
    this.reverbOut = this.ctx.createConvolver();
    this.reverbOut.buffer = this.irs.out;
    this.reverbIn = this.ctx.createConvolver();
    this.reverbIn.buffer = this.irs.in;
    this.revOutGain = this.ctx.createGain();
    this.revInGain = this.ctx.createGain();
    this.reverbOut.connect(this.revOutGain).connect(this.master);
    this.reverbIn.connect(this.revInGain).connect(this.master);
    this.revBus.connect(this.reverbOut);
    this.rooms = {} as any;
    for (const k of ['small', 'hall', 'tunnel'] as const) {
      const conv = this.ctx.createConvolver();
      conv.buffer = this.irs[k];
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      this.revBus.connect(conv);
      conv.connect(gain).connect(this.master);
      this.rooms[k] = { conv, gain };
    }
    // slapback / early reflections: two filtered taps with a little feedback, fed from the
    // reverb send; loud in the tunnel (concrete walls), subtle in small rooms
    this.echo = { in: this.ctx.createGain(), d1: this.ctx.createDelay(1), d2: this.ctx.createDelay(1), fb: this.ctx.createGain(), lp: this.ctx.createBiquadFilter(), out: this.ctx.createGain() };
    const e = this.echo;
    e.d1.delayTime.value = 0.11;
    e.d2.delayTime.value = 0.23;
    e.fb.gain.value = 0.28;
    e.lp.type = 'lowpass';
    e.lp.frequency.value = 2400;
    e.out.gain.value = 0;
    this.revBus.connect(e.in);
    e.in.connect(e.lp);
    e.lp.connect(e.d1).connect(e.out);
    e.lp.connect(e.d2).connect(e.out);
    e.d2.connect(e.fb).connect(e.lp);
    e.out.connect(this.master);
    // voices still feed sfx/ui/amb and the reverb bus, which persist across rebuilds
  }
  private echo!: { in: GainNode; d1: DelayNode; d2: DelayNode; fb: GainNode; lp: BiquadFilterNode; out: GainNode };

  applyVolumes() {
    const s = Settings.data;
    this.master.gain.value = s.masterVolume;
    this.sfx.gain.value = s.sfxVolume;
    this.amb.gain.value = s.ambienceVolume;
  }

  resume() {
    this.wantRunning = true;
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  async load(onProgress?: (p: number) => void) {
    const jobs: [string, () => Promise<AudioBuffer>][] = [];
    // (weapon audio is recorded only: see the firearm library load below)
    for (const s of ['grass', 'dirt', 'gravel', 'concrete', 'wood', 'metal', 'water']) for (let v = 0; v < 4; v++) jobs.push([`step_${s}`, () => footstep(s, v)]);
    for (const s of ['concrete', 'metal', 'wood', 'glass', 'flesh', 'water', 'dirt']) for (let v = 0; v < 2; v++) jobs.push([`imp_${s}`, () => impact(s)]);
    for (const k of ['click', 'cloth', 'adsIn', 'adsOut', 'lowAmmo', 'breathIn', 'breathOut', 'whiz', 'jump', 'land', 'mantle', 'tac', 'medal', 'flagWon', 'flagLost', 'capTick', 'streak', 'radio', 'uavPing', 'heartbeat', 'whistle', 'swish', 'pin', 'smokeHiss', 'stimHiss', 'beep', 'beepLow', 'armChirp', 'clack', 'stick', 'legs', 'claymoreClick', 'zap', 'servo', 'trophyDeploy', 'snapPulse', 'bipod', 'debris', 'fireIgnite', 'carFire'])
      jobs.push([k, () => mech(k)]);
    for (const k of ['wind', 'waves', 'rain', 'slide', 'heli', 'snowwind'] as const) jobs.push([`loop_${k}`, () => loopBuffer(k)]);
    for (let i = 0; i < 3; i++) jobs.push(['gull', () => bird('gull')]);
    for (let i = 0; i < 4; i++) jobs.push(['song', () => bird('song')]);
    // CC0 recordings (Kenney "Impact Sounds"): footsteps & impacts replace/augment synthesis
    const kenney: [string, string, number][] = [
      ['step_wood', 'footstep_wood', 5], ['step_floor', 'footstep_wood', 5], ['step_rug', 'footstep_carpet', 5],
      ['step_concrete', 'footstep_concrete', 5], ['step_grass', 'footstep_grass', 5], ['step_dirt', 'footstep_grass', 5], ['step_snow', 'footstep_snow', 5],
      ['imp_metal', 'impact_metal_medium', 5], ['imp_metal_heavy', 'impact_metal_heavy', 5], ['imp_wood', 'impact_wood_medium', 5], ['imp_plank', 'impact_plank_medium', 5],
      ['imp_glass', 'impact_glass_medium', 5], ['imp_glass_heavy', 'impact_glass_heavy', 5], ['imp_flesh', 'impact_punch_medium', 5], ['imp_dirt', 'impact_soft_heavy', 5],
      ['imp_rock', 'impact_mining', 5], ['imp_plate_light', 'impact_plate_light', 5], ['imp_plate_medium', 'impact_plate_medium', 5], ['imp_tin', 'impact_tin_medium', 5],
      ['imp_punch', 'impact_punch_heavy', 5], ['imp_generic', 'impact_generic_light', 5], ['imp_bell_heavy', 'impact_bell_heavy', 3], ['imp_metal_light', 'impact_metal_light', 5],
    ];
    const rec: Bank = {};
    await Promise.all(kenney.map(async ([key, file, n]) => {
      for (let i = 0; i < n; i++) {
        try {
          const r = await fetch(`${import.meta.env.BASE_URL}assets/sounds/kenney/${file}_${String(i).padStart(3, '0')}.ogg`);
          if (!r.ok) continue;
          const buf = await this.ctx.decodeAudioData(await r.arrayBuffer());
          (rec[key] ??= []).push(buf);
        } catch {
          /* decoding unsupported: keep synthesis */
        }
      }
    }));
    // CC0 field recordings (Free Firearm Sound Library, B. Jaszczak): gunshots and weapon handling,
    // extracted & trimmed by tools/sfx_build.py. Keys: "shot@k416", "magIn@p80", ...
    try {
      const man = await (await fetch(import.meta.env.BASE_URL + 'assets/sounds/firearms/manifest.json')).json() as Record<string, { file: string }[]>;
      await Promise.all(Object.entries(man).map(async ([key, list]) => {
        for (const { file } of list) {
          try {
            const r = await fetch(`${import.meta.env.BASE_URL}assets/sounds/firearms/${file}`);
            if (!r.ok) continue;
            (rec[key] ??= []).push(await this.ctx.decodeAudioData(await r.arrayBuffer()));
          } catch {
            /* keep synthesis for this one */
          }
        }
      }));
      // recorded gunshots replace the synthesised ones
      for (const id of Object.keys(WEAPONS)) {
        if (rec[`shot@${id}`]?.length) rec[`shot_${id}`] = rec[`shot@${id}`];
        if (rec[`far@${id}`]?.length) rec[`far_${id}`] = rec[`far@${id}`];
      }
    } catch {
      /* no manifest: synthesis only */
    }
    // voice callouts (generated with ElevenLabs by tools/voice_build.py): keys "vo_bot0a_reload"
    try {
      const vm = await (await fetch(import.meta.env.BASE_URL + 'assets/sounds/voice/manifest.json')).json() as Record<string, Record<string, string[]>>;
      const texts = await (await fetch(import.meta.env.BASE_URL + 'assets/sounds/voice/lines.json')).json().catch(() => ({})) as Record<string, string>;
      await Promise.all(Object.entries(vm).flatMap(([spk, lines]) => Object.entries(lines).map(async ([line, files]) => {
        // keep variant order stable so subtitles match the take that plays
        const key = `vo_${spk}_${line}`;
        const bufs: AudioBuffer[] = [], subs: string[] = [];
        for (const f of files) {
          try {
            const r = await fetch(`${import.meta.env.BASE_URL}assets/sounds/voice/${f}`);
            if (!r.ok) continue;
            bufs.push(await this.ctx.decodeAudioData(await r.arrayBuffer()));
            subs.push(texts[f] ?? '');
          } catch {
            /* skip */
          }
        }
        if (bufs.length) {
          rec[key] = bufs;
          this.voiceText[key] = subs;
        }
      })));
    } catch {
      /* no voice pack */
    }
    // hitmarker + elimination sounds supplied for the game (public/assets/sounds/ui); they
    // replace the designed ones after designSounds() runs
    const provided: Bank = {};
    await Promise.all(([['hit', 'hitmarker'], ['headshot', 'hitmarker'], ['kill', 'killsound'], ['killHead', 'killsound']] as const).map(async ([key, f]) => {
      try {
        const r = await fetch(`${import.meta.env.BASE_URL}assets/sounds/ui/${f}.ogg`);
        if (r.ok) provided[key] = [await this.ctx.decodeAudioData(await r.arrayBuffer())];
      } catch {
        /* keep the designed one */
      }
    }));
    // death cries (ElevenLabs sound generation, ten different takes)
    const screams = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
      try {
        const r = await fetch(`${import.meta.env.BASE_URL}assets/sounds/designed/scream${i}.ogg`);
        return r.ok ? await this.ctx.decodeAudioData(await r.arrayBuffer()) : null;
      } catch {
        return null;
      }
    }));
    const sc = screams.filter((b): b is AudioBuffer => !!b);
    if (sc.length) provided.scream = sc;
    // designed one-shots (ElevenLabs sound generation, tools/music_build.py)
    await Promise.all(([['nvgOn', 'nvg_on'], ['nvgOff', 'nvg_off'], ['glassCrack', 'glass_crack'], ['glassShatter', 'glass_shatter'], ['doorBreach', 'door_breach0'], ['doorBreach', 'door_breach1'], ['doorBreach', 'door_breach2']] as const).map(async ([key, f]) => {
      try {
        const r = await fetch(`${import.meta.env.BASE_URL}assets/sounds/designed/${f}.ogg`);
        if (r.ok) (rec[key] ??= []).push(await this.ctx.decodeAudioData(await r.arrayBuffer()));
      } catch {
        /* optional */
      }
    }));
    let done = 0;
    // render in small parallel batches
    for (let i = 0; i < jobs.length; i += 6) {
      const batch = jobs.slice(i, i + 6);
      const res = await Promise.all(batch.map(([, f]) => f()));
      batch.forEach(([k], j) => (this.bank[k] ??= []).push(res[j]));
      done += batch.length;
      onProgress?.(done / jobs.length);
    }
    // recorded sounds override the synthesised ones where available
    for (const [k, v] of Object.entries(rec)) if (v.length) this.bank[k] = v;
    await this.designSounds();
    for (const [k, v] of Object.entries(provided)) this.bank[k] = v;
    this.ready = true;
  }

  /**
   * Sounds designed from the CC0 recordings (offline-rendered layers, EQ and saturation):
   *  hit / hitHead   — the hit-marker "tk": bright plate tick + tight body knock
   *  kill / killHead — the confirm: low punch thump, metal snap and a short ringing tail
   *  shot_skv338     — the sniper rebuilt heavier: the Tikka report + a pitched-down body layer
   *                    for chest-thump weight + the long distant roll as tail
   * Synthesised weapon audio is gone; everything weapon-related is built from field recordings.
   */
  private async designSounds() {
    const B = (k: string, i = 0) => this.bank[k]?.[i % Math.max(1, this.bank[k]?.length ?? 1)];
    type Layer = { buf?: AudioBuffer; rate?: number; gain?: number; at?: number; hp?: number; lp?: number; drive?: number };
    const render = async (layers: Layer[], dur: number, master = 1) => {
      const sr = 48000;
      const oc = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
      const out = oc.createDynamicsCompressor();
      out.threshold.value = -12; out.ratio.value = 4; out.attack.value = 0.001; out.release.value = 0.08;
      const mg = oc.createGain();
      mg.gain.value = master;
      out.connect(mg).connect(oc.destination);
      for (const L of layers) {
        if (!L.buf) continue;
        const src = oc.createBufferSource();
        src.buffer = L.buf;
        src.playbackRate.value = L.rate ?? 1;
        let node: AudioNode = src;
        if (L.hp) { const f = oc.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = L.hp; node.connect(f); node = f; }
        if (L.lp) { const f = oc.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = L.lp; node.connect(f); node = f; }
        if (L.drive) {
          const ws = oc.createWaveShaper();
          const c = new Float32Array(1024);
          for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; c[i] = Math.tanh(x * L.drive) / Math.tanh(L.drive); }
          ws.curve = c;
          node.connect(ws); node = ws;
        }
        const g = oc.createGain();
        g.gain.value = L.gain ?? 1;
        node.connect(g).connect(out);
        src.start(L.at ?? 0);
      }
      return oc.startRendering();
    };
    const norm = (buf: AudioBuffer, peak: number) => {
      let m = 1e-6;
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
      }
      const k = peak / m;
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) d[i] *= k;
      }
      return buf;
    };
    const PEAK: Record<string, number> = { flashBang: 0.98, stunBang: 0.95, smokePop: 0.6, stimInject: 0.7, explosion: 0.98, explosionFar: 0.8, doorOpen: 0.6, hit: 0.72, headshot: 0.78, kill: 0.92, killHead: 0.95, shot_skv338: 0.95, shot_rv357: 0.95, shot_dmr14: 0.96, shot_db12: 0.97, shot_as20: 0.95 };
    const set = async (key: string, variants: (() => Promise<AudioBuffer>)[]) => {
      try {
        this.bank[key] = (await Promise.all(variants.map((f) => f()))).map((b) => norm(b, PEAK[key] ?? 0.9));
      } catch (e) {
        console.warn('[audio] design failed', key, e);
      }
    };
    const plate = 'imp_plate_light', tin = 'imp_tin', punch = 'imp_punch', metalH = 'imp_metal_heavy', gen = 'imp_generic';
    await set('hit', [0, 1, 2].map((v) => () => render([
      { buf: B(plate, v), rate: 2.3, gain: 0.9, hp: 1800 },
      { buf: B(gen, v), rate: 1.7, gain: 0.55, hp: 600, lp: 6000 },
      { buf: B(tin, v), rate: 2.6, gain: 0.25, hp: 3000 },
    ], 0.14, 1.1)));
    await set('headshot', [0, 1].map((v) => () => render([
      { buf: B(plate, v), rate: 2.0, gain: 0.8, hp: 1500 },
      { buf: this.bank['imp_bell_heavy']?.[0] ?? B(metalH, v), rate: 2.4, gain: 0.45, hp: 2000 },
      { buf: B(tin, v + 1), rate: 2.9, gain: 0.35, hp: 2500 },
    ], 0.35, 1.0)));
    await set('kill', [0, 1, 2].map((v) => () => render([
      { buf: B(punch, v), rate: 0.62, gain: 1.0, lp: 900, drive: 2.2 }, // the chest thump
      { buf: B(punch, v + 1), rate: 1.05, gain: 0.55, hp: 300 },
      { buf: B(metalH, v), rate: 1.55, gain: 0.5, hp: 1200, at: 0.008 }, // metallic snap
      { buf: B(plate, v), rate: 2.1, gain: 0.55, hp: 2200, at: 0.012 },
      { buf: B(tin, v), rate: 1.2, gain: 0.22, hp: 1500, at: 0.05 }, // short ring
    ], 0.7, 1.15)));
    await set('killHead', [0, 1].map((v) => () => render([
      { buf: B(punch, v), rate: 0.58, gain: 1.0, lp: 800, drive: 2.5 },
      { buf: B(metalH, v), rate: 1.7, gain: 0.55, hp: 1300, at: 0.006 },
      { buf: this.bank['imp_bell_heavy']?.[0] ?? B(plate, v), rate: 2.2, gain: 0.5, hp: 1800, at: 0.01 },
      { buf: B(plate, v + 1), rate: 2.4, gain: 0.5, hp: 2400, at: 0.014 },
    ], 0.8, 1.15)));
    // explosions (frag grenade, mortar): recorded gunshot reports pitched far down for the blast body,
    // the distant roll for the tail, rock/dirt impacts as falling debris
    const boom = this.bank['shot@skv338'] ?? this.bank['shot@k416'] ?? [];
    const roll = this.bank['far@skv338'] ?? this.bank['far@k416'] ?? [];
    if (boom.length) {
      await set('explosion', [0, 1, 2].map((v) => () => render([
        { buf: boom[v % boom.length], rate: 0.34 + v * 0.03, gain: 1.0, lp: 700, drive: 3.0 },
        { buf: boom[(v + 1) % boom.length], rate: 0.22, gain: 0.8, lp: 180, drive: 1.6 },
        { buf: boom[v % boom.length], rate: 0.6, gain: 0.45, hp: 600, drive: 2 },
        { buf: roll[v % Math.max(1, roll.length)], rate: 0.55, gain: 0.7, at: 0.05, lp: 900 },
        { buf: B('imp_rock', v), rate: 0.8, gain: 0.35, at: 0.25 },
        { buf: B('imp_dirt', v), rate: 0.7, gain: 0.45, at: 0.4 },
        { buf: B('imp_rock', v + 2), rate: 1.1, gain: 0.2, at: 0.62 },
      ], 3.4, 1.0)));
      await set('explosionFar', [0, 1].map((v) => () => render([
        { buf: boom[v % boom.length], rate: 0.3, gain: 1.0, lp: 320, drive: 1.8 },
        { buf: roll[v % Math.max(1, roll.length)], rate: 0.5, gain: 0.9, at: 0.03, lp: 500 },
      ], 3.6, 0.8)));
    }
    // tacticals: flashbang = a hard, bright crack with a metallic ring; stun = a deep concussive
    // thump; smoke = a soft pop then a long hiss; stim = click, needle punch, pressurised hiss
    if (boom.length) {
      await set('flashBang', [0, 1].map((v) => () => render([
        { buf: boom[v % boom.length], rate: 0.85, gain: 1.0, hp: 400, drive: 3.2 },
        { buf: boom[(v + 1) % boom.length], rate: 0.5, gain: 0.6, lp: 500, drive: 1.6 },
        { buf: this.bank['imp_bell_heavy']?.[v % 3] ?? B(metalH, v), rate: 1.6, gain: 0.5, hp: 1200, at: 0.005 },
        { buf: roll[v % Math.max(1, roll.length)], rate: 0.7, gain: 0.5, at: 0.04, lp: 1600 },
      ], 2.6, 1.0)));
      await set('stunBang', [0, 1].map((v) => () => render([
        { buf: boom[v % boom.length], rate: 0.42, gain: 1.0, lp: 380, drive: 2.6 },
        { buf: boom[(v + 1) % boom.length], rate: 0.3, gain: 0.8, lp: 140 },
        { buf: B(metalH, v), rate: 0.7, gain: 0.35, lp: 1200, at: 0.01 },
        { buf: roll[v % Math.max(1, roll.length)], rate: 0.45, gain: 0.6, at: 0.03, lp: 600 },
      ], 3.0, 1.0)));
    }
    await set('smokePop', [0, 1].map((v) => () => render([
      { buf: B('imp_metal_light', v), rate: 0.9, gain: 0.7 },
      { buf: B(punch, v), rate: 0.7, gain: 0.6, lp: 900 },
    ], 0.6, 0.8)));
    await set('stimInject', [0, 1].map((v) => () => render([
      { buf: B('imp_metal_light', v), rate: 2.2, gain: 0.6, hp: 1500 },
      { buf: B(punch, v), rate: 1.2, gain: 0.7, lp: 2500, at: 0.05 },
      { buf: B('imp_plate_light', v), rate: 2.8, gain: 0.3, hp: 3000, at: 0.06 },
    ], 0.5, 0.8)));
    await set('nadeBounce', [0, 1, 2].map((v) => () => render([
      { buf: B('imp_metal_light', v), rate: 1.25, gain: 0.8 },
      { buf: B('imp_generic', v), rate: 0.9, gain: 0.5 },
    ], 0.4, 0.9)));
    await set('knife', [0, 1, 2].map((v) => () => render([
      { buf: B(punch, v), rate: 0.85, gain: 1.0, lp: 2500, drive: 1.5 },
      { buf: B('imp_flesh', v), rate: 0.7, gain: 0.8 },
      { buf: B(metalH, v), rate: 2.4, gain: 0.18, hp: 3000, at: 0.01 },
    ], 0.5, 1.0)));
    await set('doorKick', [0, 1].map((v) => () => render([
      { buf: B('imp_wood', v), rate: 0.6, gain: 1.0, drive: 1.8 },
      { buf: B('imp_plank', v), rate: 0.75, gain: 0.8, at: 0.01 },
      { buf: B(punch, v), rate: 0.55, gain: 0.6, lp: 600 },
      { buf: B('imp_wood', v + 2), rate: 0.9, gain: 0.5, at: 0.32 },
    ], 1.0, 1.0)));
    await set('doorOpen', [0, 1].map((v) => () => render([
      { buf: B('imp_plank', v), rate: 1.1, gain: 0.5, hp: 300 },
      { buf: B('imp_metal_light', v), rate: 1.8, gain: 0.25, hp: 1500, at: 0.02 },
      { buf: B('imp_wood', v + 1), rate: 1.4, gain: 0.2, at: 0.05 },
    ], 0.6, 0.6)));
    // .357 Magnum: the recorded .38 revolver report with a pitched-down, driven body layer and
    // the distant tail — a sharp, heavy crack with a lot more weight than the 9 mm
    const rv = this.bank['shot@rv357'] ?? [], rvFar = this.bank['far@rv357'] ?? [];
    if (rv.length) {
      await set('shot_rv357', rv.map((b, i) => () => render([
        { buf: b, rate: 0.94, gain: 1.0, drive: 1.8 },
        { buf: b, rate: 0.66, gain: 0.8, lp: 600, drive: 2.6 },
        { buf: b, rate: 0.5, gain: 0.45, lp: 200 },
        { buf: rvFar[i % Math.max(1, rvFar.length)], rate: 0.9, gain: 0.45, at: 0.03, lp: 3000 },
      ], 2.4, 1.0)));
    }
    // heavier sniper: original report, a pitched-down body (weight), saturation and the distant roll
    const sn = this.bank['shot@skv338'] ?? [], far = this.bank['far@skv338'] ?? [];
    if (sn.length) {
      await set('shot_skv338', sn.map((b, i) => () => render([
        { buf: b, rate: 1, gain: 1.0, drive: 1.6 },
        { buf: b, rate: 0.7, gain: 0.85, lp: 420, drive: 2.4 },
        { buf: b, rate: 0.52, gain: 0.5, lp: 160 },
        { buf: far[i % Math.max(1, far.length)], rate: 0.92, gain: 0.5, at: 0.035, lp: 2600 },
      ], 3.2, 1.0)));
    }
    // FJ-14 marksman rifle (7.62 semi-auto): the .30-cal Tikka report tightened up, the AR's
    // mechanical crack on top, a driven low body, the distant roll and the op-rod clack of the
    // action cycling — a hard, punchy "whack" with a long tail
    const ar = this.bank['shot@k416'] ?? [];
    if (sn.length) {
      const clack = this.bank['boltRelease@k416']?.[0];
      await set('shot_dmr14', [0, 1, 2].map((i) => () => render([
        { buf: sn[i % sn.length], rate: 1.13, gain: 1.0, drive: 1.75 },
        ...(ar.length ? [{ buf: ar[i % ar.length], rate: 0.84, gain: 0.55, hp: 900, drive: 1.4 }] : []),
        { buf: sn[i % sn.length], rate: 0.76, gain: 0.72, lp: 380, drive: 2.3 },
        ...(far.length ? [{ buf: far[i % far.length], rate: 1.06, gain: 0.45, at: 0.03, lp: 2800 }] : []),
        ...(clack ? [{ buf: clack, rate: 1.3, gain: 0.2, at: 0.05, hp: 1500 }] : []),
      ], 2.6, 1.0)));
      if (far.length) this.bank['far_dmr14'] = far;
    }
    // AS-20 auto shotgun: the recorded 12 gauge report tightened (rate up, less boom tail) with the
    // gas action's clack on top; DB "Tvilling": the 12 gauge doubled in weight — a pitched-down,
    // driven body under the report and a longer tail
    const sg = this.bank['shot@pump12'] ?? [], sgFar = this.bank['far@pump12'] ?? [];
    if (sg.length) {
      const clack = this.bank['boltRelease@k416']?.[0];
      await set('shot_as20', [0, 1, 2].map((i) => () => render([
        { buf: sg[i % sg.length], rate: 1.08, gain: 1.0, drive: 1.5 },
        { buf: sg[i % sg.length], rate: 0.8, gain: 0.5, lp: 500, drive: 2.0 },
        ...(clack ? [{ buf: clack, rate: 1.15, gain: 0.32, at: 0.045, hp: 900 }] : []),
      ], 2.2, 1.0)));
      await set('shot_db12', [0, 1, 2].map((i) => () => render([
        { buf: sg[i % sg.length], rate: 0.94, gain: 1.0, drive: 1.8 },
        { buf: sg[i % sg.length], rate: 0.64, gain: 0.85, lp: 420, drive: 2.6 },
        { buf: sg[i % sg.length], rate: 0.5, gain: 0.45, lp: 180 },
        ...(sgFar.length ? [{ buf: sgFar[i % sgFar.length], rate: 0.9, gain: 0.45, at: 0.03, lp: 2600 }] : []),
      ], 2.8, 1.0)));
      if (sgFar.length) this.bank['far_as20'] = this.bank['far_db12'] = sgFar;
    }
    // AS-20 handling: box mag (bolt rifle), charging handle (AR); Tvilling: break open / close are the
    // bolt rifle's bolt opening and the pump slamming home, shells from the pump
    for (const [k, src] of [['magOut', 'magOut@skv338'], ['magIn', 'magIn@skv338'], ['boltBack', 'boltBack@k416'], ['boltRelease', 'boltRelease@k416'], ['dry', 'dry@pump12']] as const) {
      if (this.bank[src]) this.bank[`${k}@as20`] = this.bank[src];
    }
    for (const [k, src] of [['boltOpen', 'boltOpen@skv338'], ['boltClose', 'pumpForward@pump12'], ['shellIn', 'shellIn@pump12'], ['dry', 'dry@pump12'], ['boltBack', 'pumpBack@pump12'], ['magTouch', 'shellIn@pump12']] as const) {
      if (this.bank[src]) this.bank[`${k}@db12`] = this.bank[src];
    }
    // KS-17: the carbine report with a heavier, slightly lower body (longer upper, slower cyclic)
    if (ar.length) {
      await set('shot_ks17', ar.map((buf) => () => render([
        { buf, rate: 0.95, gain: 1.0, drive: 1.35 },
        { buf, rate: 0.72, gain: 0.45, lp: 520, drive: 2.0 },
      ], 1.6, 1.0)));
      if (this.bank['far@k416']) this.bank['far_ks17'] = this.bank['far@k416'];
    }
    for (const k of ['magOut', 'magIn', 'magTouch', 'boltBack', 'boltRelease', 'slideBack', 'dry', 'rattle']) {
      if (this.bank[`${k}@k416`]) this.bank[`${k}@ks17`] = this.bank[`${k}@k416`];
    }
    // KVL-7 LMG: the carbine report with a big open receiver chug — pitched down a touch, a driven
    // low body and a little of the .338's crack and tail for weight
    const snp = this.bank['shot@skv338'] ?? [];
    if (ar.length) {
      await set('shot_lmg', ar.map((buf, i) => () => render([
        { buf, rate: 0.9, gain: 1.0, drive: 1.5 },
        { buf, rate: 0.66, gain: 0.55, lp: 480, drive: 2.3 },
        ...(snp.length ? [{ buf: snp[i % snp.length], rate: 1.25, gain: 0.22, lp: 3000, drive: 1.2 }] : []),
      ], 1.8, 1.0)));
      if (this.bank['far@k416']) this.bank['far_lmg'] = this.bank['far@k416'];
    }
    // handling: rifle charging handle, sniper mag thunk for the box going in / out
    for (const [k, src] of [['magOut', 'magOut@skv338'], ['magIn', 'magIn@skv338'], ['magTouch', 'magTouch@k416'], ['boltBack', 'boltBack@k416'], ['boltRelease', 'boltRelease@k416'], ['dry', 'dry@k416'], ['rattle', 'rattle@k416'], ['boltOpen', 'boltOpen@skv338'], ['boltClose', 'boltClose@skv338']] as const) {
      if (this.bank[src]) this.bank[`${k}@lmg`] = this.bank[src];
    }
    // UMS-45: .45 ACP is slower and fatter than the PDW's 4.6 — the PDW report pitched down with the
    // 9 mm pistol's punch underneath and a driven low thump
    const pdw = this.bank['shot@mp7'] ?? [], pst = this.bank['shot@p80'] ?? [];
    if (pdw.length) {
      await set('shot_ums45', pdw.map((buf, i) => () => render([
        { buf, rate: 0.82, gain: 0.95, drive: 1.4 },
        ...(pst.length ? [{ buf: pst[i % pst.length], rate: 0.78, gain: 0.55, lp: 2400, drive: 1.3 }] : []),
        { buf, rate: 0.58, gain: 0.5, lp: 420, drive: 2.2 },
      ], 1.5, 1.0)));
      if (this.bank['far@mp7']) this.bank['far_ums45'] = this.bank['far@mp7'];
    }
    for (const k of ['magOut', 'magIn', 'magTouch', 'boltBack', 'boltRelease', 'slideBack', 'dry', 'rattle']) {
      if (this.bank[`${k}@mp7`]) this.bank[`${k}@ums45`] = this.bank[`${k}@mp7`];
    }
    // gunshot layers get their own names (own voice caps): low thump + distant tail per weapon
    for (const id of Object.keys(WEAPONS)) {
      const near = this.bank[`shot_${id}`];
      if (!near?.length) continue;
      this.bank[`low_${id}`] = near;
      this.bank[`tail_${id}`] = this.bank[`far_${id}`] ?? this.bank[`far@${id}`] ?? near;
    }
    // FJ-14 handling: box-mag sounds from the bolt rifle, op-rod charge from the AR's charging handle
    for (const [k, src] of [['magOut', 'magOut@skv338'], ['magIn', 'magIn@skv338'], ['boltBack', 'boltBack@k416'], ['boltRelease', 'boltRelease@k416'], ['dry', 'dry@skv338']] as const) {
      if (this.bank[src]) this.bank[`${k}@dmr14`] = this.bank[src];
    }
  }

  setListener(cam: THREE.Camera) {
    const l = this.ctx.listener;
    const p = cam.getWorldPosition(this.tmpL);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    if (![p.x, p.y, p.z, f.x, f.y, f.z, u.x, u.y, u.z].every(Number.isFinite)) return;
    this.listenerPos.copy(p);
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, 0.01);
      l.positionY.setTargetAtTime(p.y, t, 0.01);
      l.positionZ.setTargetAtTime(p.z, t, 0.01);
      l.forwardX.setTargetAtTime(f.x, t, 0.01);
      l.forwardY.setTargetAtTime(f.y, t, 0.01);
      l.forwardZ.setTargetAtTime(f.z, t, 0.01);
      l.upX.setTargetAtTime(u.x, t, 0.01);
      l.upY.setTargetAtTime(u.y, t, 0.01);
      l.upZ.setTargetAtTime(u.z, t, 0.01);
    } else {
      (l as any).setPosition(p.x, p.y, p.z);
      (l as any).setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
    const r = this.room;
    this.revOutGain.gain.setTargetAtTime(0.55 * r.outdoor, t, 0.25);
    this.revInGain.gain.setTargetAtTime(0, t, 0.25);
    this.rooms.small.gain.gain.setTargetAtTime(0.55 * r.small, t, 0.25);
    this.rooms.hall.gain.gain.setTargetAtTime(0.6 * r.hall, t, 0.25);
    this.rooms.tunnel.gain.gain.setTargetAtTime(0.65 * r.tunnel, t, 0.25);
    // tunnel: long slapback; small rooms: tight early reflections
    const tun = r.tunnel, small = r.small + r.hall * 0.6;
    this.echo.d1.delayTime.setTargetAtTime(tun > 0.5 ? 0.11 : 0.028, t, 0.2);
    this.echo.d2.delayTime.setTargetAtTime(tun > 0.5 ? 0.23 : 0.047, t, 0.2);
    this.echo.fb.gain.setTargetAtTime(tun > 0.5 ? 0.32 : 0.12, t, 0.2);
    this.echo.out.gain.setTargetAtTime(0.75 * tun + 0.22 * small, t, 0.25);
  }

  /** Is a sound bank entry loaded? */
  has(name: string) {
    return !!this.bank[name]?.length;
  }

  /** Active one-shot voices (oldest first) for voice limiting and stealing. */
  private voices: { src: AudioBufferSourceNode; nodes: AudioNode[]; name: string; t: number; prio: number }[] = [];
  private hrtfVoices = 0;
  static MAX_VOICES = 52;
  static MAX_PER_NAME = 6;

  private release(v: { src: AudioBufferSourceNode; nodes: AudioNode[] }) {
    try {
      v.src.onended = null;
      v.src.stop();
    } catch { /* already stopped */ }
    for (const n of v.nodes) {
      try { n.disconnect(); } catch { /* ignore */ }
    }
  }

  /** Play a sound. pos = world position (spatialised), otherwise 2D. Never throws; never injects NaN. */
  play(name: string, opts: { pos?: THREE.Vector3; gain?: number; rate?: number; vary?: number; ref?: number; reverb?: number; delay?: boolean; bus?: 'sfx' | 'ui' | 'amb'; lowpass?: number; prio?: number; variant?: number; maxDist?: number; at?: number } = {}) {
    if (!this.ready || this.ctx.state !== 'running') return null;
    const list = this.bank[name];
    if (!list || !list.length) return null;
    try {
      const v = opts.variant !== undefined ? list[opts.variant % list.length] : list[Math.floor(Math.random() * list.length)];
      if (!v) return null;
      return this.playVoice(name, v, opts);
    } catch (e) {
      console.warn('[audio] play failed', name, e);
      return null;
    }
  }

  private playVoice(name: string, buf: AudioBuffer, opts: Parameters<AudioEngine['play']>[1] & object) {
    const fin = (v: number, d: number) => (Number.isFinite(v) ? v : d);
    const now = this.ctx.currentTime;
    const prio = opts.prio ?? (opts.bus === 'ui' ? 3 : opts.pos ? 1 : 2);
    // ---- voice management: per-sound cap, then global cap (steal the oldest, lowest priority voice)
    let same = 0;
    for (const v of this.voices) if (v.name === name) same++;
    // hitmarkers overlap freely (each hit is its own tick)
    if (same >= (name === 'hit' || name === 'headshot' ? 24 : AudioEngine.MAX_PER_NAME)) {
      const i = this.voices.findIndex((v) => v.name === name);
      if (i >= 0) this.release(this.voices.splice(i, 1)[0]);
    }
    if (this.voices.length >= AudioEngine.MAX_VOICES) {
      let k = -1;
      for (let i = 0; i < this.voices.length; i++) if (this.voices[i].prio <= prio && (k < 0 || this.voices[i].prio < this.voices[k].prio)) k = i;
      if (k < 0) return null; // everything playing matters more
      this.release(this.voices.splice(k, 1)[0]);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const vary = fin(opts.vary ?? 0.04, 0);
    src.playbackRate.value = Math.min(4, Math.max(0.25, fin((opts.rate ?? 1) * (1 + (Math.random() * 2 - 1) * vary), 1)));
    const g = this.ctx.createGain();
    g.gain.value = Math.min(4, Math.max(0, fin(opts.gain ?? 1, 1)));
    const nodes: AudioNode[] = [src, g];
    let node: AudioNode = src;
    let when = now + Math.min(3, Math.max(0, fin(opts.at ?? 0, 0)));
    const pos = opts.pos;
    const spatial = !!pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z);
    let hrtf = false;
    if (spatial) {
      const dist = fin(pos!.distanceTo(this.listenerPos), 50);
      if (opts.maxDist) {
        // hard audible range (voices): fade out over the last 40 %
        const k = 1 - Math.min(1, Math.max(0, (dist - opts.maxDist * 0.6) / (opts.maxDist * 0.4)));
        if (k <= 0) return null;
        g.gain.value *= k;
      }
      if (opts.delay) when += Math.min(dist / 343, 1.5);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.min(20000, Math.max(250, fin(opts.lowpass ?? Math.max(700, 18000 / (1 + dist / 40)), 8000)));
      node.connect(lp);
      node = lp;
      const pan = this.ctx.createPanner();
      // HRTF is expensive: only for a handful of close voices
      hrtf = dist < 30 && this.hrtfVoices < 6;
      pan.panningModel = hrtf ? 'HRTF' : 'equalpower';
      pan.distanceModel = 'inverse';
      pan.refDistance = Math.max(0.1, fin(opts.ref ?? 2, 2));
      pan.rolloffFactor = 1.1;
      pan.maxDistance = 2000;
      pan.positionX.value = pos!.x;
      pan.positionY.value = pos!.y;
      pan.positionZ.value = pos!.z;
      node.connect(pan);
      node = pan;
      nodes.push(lp, pan);
    }
    node.connect(g);
    g.connect(opts.bus === 'ui' ? this.ui : opts.bus === 'amb' ? this.amb : this.sfx);
    const rv = fin(opts.reverb ?? 0.25, 0);
    if (rv > 0) {
      const send = this.ctx.createGain();
      send.gain.value = Math.min(2, rv);
      g.connect(send);
      send.connect(this.revBus);
      nodes.push(send);
    }
    const voice = { src, nodes, name, t: now, prio };
    if (hrtf) this.hrtfVoices++;
    src.onended = () => {
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
      if (hrtf) this.hrtfVoices = Math.max(0, this.hrtfVoices - 1);
      for (const n of nodes) {
        try { n.disconnect(); } catch { /* ignore */ }
      }
    };
    this.voices.push(voice);
    src.start(when);
    return src;
  }

  /**
   * Watchdog: a single non-finite sample poisons recursive DSP state (compressor envelope,
   * convolver tails) and the whole mix goes silent for good. Probe the master bus and rebuild
   * the shared processing chain if that ever happens; also auto-resume a suspended context.
   */
  private watchT = 0;
  private probe: AnalyserNode | null = null;
  private probeBuf = new Float32Array(256);
  watchdog(dt: number) {
    this.watchT -= dt;
    if (this.watchT > 0) return;
    this.watchT = 0.5;
    if (this.ctx.state === 'suspended' && this.wantRunning) this.ctx.resume().catch(() => {});
    if (!this.probe) return;
    this.probe.getFloatTimeDomainData(this.probeBuf);
    for (let i = 0; i < this.probeBuf.length; i++) {
      if (!Number.isFinite(this.probeBuf[i])) {
        console.warn('[audio] non-finite signal on the master bus: rebuilding the mix chain');
        this.rebuildChain();
        return;
      }
    }
  }
  private wantRunning = false;

  loop(name: string, gain: number, pos?: THREE.Vector3) {
    if (!this.ready || !Number.isFinite(gain)) return;
    if (pos && !(Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z))) pos = undefined;
    let l = this.loops[name];
    if (!l) {
      const buf = this.bank[`loop_${name}`]?.[0];
      if (!buf) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      let node: AudioNode = src;
      let panner: PannerNode | undefined;
      if (pos) {
        panner = this.ctx.createPanner();
        panner.distanceModel = 'inverse';
        panner.refDistance = 12;
        panner.rolloffFactor = 0.8;
        node.connect(panner);
        node = panner;
      }
      node.connect(g).connect(name === 'slide' ? this.sfx : this.amb);
      src.start();
      l = this.loops[name] = { src, gain: g, panner };
    }
    l.gain.gain.setTargetAtTime(gain, this.ctx.currentTime, name === 'slide' ? 0.04 : 0.6);
    if (pos && l.panner) {
      l.panner.positionX.value = pos.x;
      l.panner.positionY.value = pos.y;
      l.panner.positionZ.value = pos.z;
    }
  }

  /**
   * Positional looping emitters (burning vehicles, tunnel shaft wind): created on first use, then
   * gain / position / filter are steered every frame; a gain of 0 for a while stops and frees it.
   */
  private emitters = new Map<string, { src: AudioBufferSourceNode; gain: GainNode; lp: BiquadFilterNode; pan: PannerNode; idle: number }>();
  emitter(key: string, buf: string, gain: number, pos: THREE.Vector3, opts: { ref?: number; lowpass?: number; rate?: number; bus?: 'sfx' | 'amb' } = {}) {
    if (!this.ready || this.ctx.state !== 'running' || !Number.isFinite(gain) || !Number.isFinite(pos.x)) return;
    let e = this.emitters.get(key);
    if (!e) {
      if (gain < 0.002) return;
      const b = this.bank[buf]?.[0];
      if (!b) return;
      const src = this.ctx.createBufferSource();
      src.buffer = b;
      src.loop = true;
      src.playbackRate.value = opts.rate ?? 1;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = opts.lowpass ?? 20000;
      const pan = this.ctx.createPanner();
      pan.panningModel = 'equalpower';
      pan.distanceModel = 'inverse';
      pan.refDistance = opts.ref ?? 4;
      pan.rolloffFactor = 1.2;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      src.connect(lp).connect(pan).connect(g).connect(opts.bus === 'sfx' ? this.sfx : this.amb);
      // start somewhere random in the loop so two emitters of one buffer never phase
      src.start(this.ctx.currentTime, Math.random() * b.duration);
      e = { src, gain: g, lp, pan, idle: 0 };
      this.emitters.set(key, e);
    }
    const t = this.ctx.currentTime;
    e.gain.gain.setTargetAtTime(Math.min(3, gain), t, 0.25);
    e.pan.positionX.value = pos.x;
    e.pan.positionY.value = pos.y;
    e.pan.positionZ.value = pos.z;
    if (opts.lowpass) e.lp.frequency.setTargetAtTime(opts.lowpass, t, 0.15);
    if (opts.rate) e.src.playbackRate.setTargetAtTime(opts.rate, t, 0.3);
    e.idle = gain < 0.002 ? e.idle + 1 : 0;
    if (e.idle > 120) this.stopEmitter(key);
  }
  stopEmitter(key: string) {
    const e = this.emitters.get(key);
    if (!e) return;
    this.emitters.delete(key);
    try {
      e.src.stop();
      e.src.disconnect();
      e.gain.disconnect();
    } catch { /* ignore */ }
  }

  /** Ambience director: wind, waves near the shore, birds, gulls by the harbour, rain. */
  ambience(dt: number, cam: THREE.Vector3, shoreDist: number, weather: string, elevation: number) {
    this.watchdog(dt);
    if (!this.ready || this.ctx.state !== 'running') return;
    {
      const t = this.ctx.currentTime;
      const k = Math.max(this.tinnitus * 1.1, this.hurt * 0.75);
      const f = Number.isFinite(k) ? 20000 * Math.pow(0.028, Math.min(1, k)) : 20000;
      this.muffle.frequency.setTargetAtTime(Math.max(380, f), t, 0.08);
      this.ring.gain.setTargetAtTime(Number.isFinite(this.tinnitus) ? Math.pow(this.tinnitus, 1.5) * 0.035 : 0, t, 0.1);
    }
    const windG = 0.25 + Math.min(0.4, Math.max(0, elevation - 10) * 0.01) + (weather === 'rain' ? 0.15 : 0);
    this.loop('wind', windG * (1 - this.indoor * 0.6));
    const shore = Math.max(0, 1 - shoreDist / 70);
    this.loop('waves', 0.6 * shore * (1 - this.indoor * 0.5), new THREE.Vector3(cam.x - Math.min(shoreDist, 40), 0, cam.z));
    this.loop('rain', weather === 'rain' ? 0.35 * (1 - this.indoor * 0.4) : 0);
    this.loop('snowwind', weather === 'snow' ? (0.22 + this.windGust * 0.25) * (1 - this.indoor * 0.75) : 0);
    this.birdT -= dt;
    if (this.birdT <= 0) {
      this.birdT = 2 + Math.random() * 6;
      const a = Math.random() * Math.PI * 2;
      const p = new THREE.Vector3(cam.x + Math.cos(a) * 30, cam.y + 12, cam.z + Math.sin(a) * 30);
      if (shore > 0.2 && Math.random() < 0.7) this.play('gull', { pos: p, gain: 0.35, ref: 10, bus: 'amb', reverb: 0.3, vary: 0.1 });
      else if (weather !== 'rain') this.play('song', { pos: p, gain: 0.18, ref: 8, bus: 'amb', reverb: 0.15, vary: 0.12 });
    }
  }
}
