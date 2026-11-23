/**
 * The Nordlys score (Update 45): an adaptive underscore played live by the audio engine during a
 * match, in the key and tempo of the composed menu theme (D minor, 88 BPM), so the two belong
 * together.
 *
 * Layers enter and leave with a single "intensity" (0 calm … 1 heavy firefight) the game feeds in:
 *   pad      always: slow detuned-saw chords through a breathing low-pass and a long cold hall
 *   glints   always, sparse: high sine "aurora" notes that swell in and hang in the reverb
 *   pulse    ≥ 0.22: a sub-bass eighth-note pulse on the chord root, ducking the pad
 *   arp      ≥ 0.12: glassy FM plucks on the chord tones through a dotted-eighth ping-pong delay
 *   drums    ≥ 0.5: frame-drum hits and ticking hats; ≥ 0.78 a soft snare on the backbeat
 * Calm uses i–VI–III–VII (Dm Bb F C); intense switches to i–VI–iv–V (Dm Bb Gm A) at the next
 * phrase. Everything is scheduled a little ahead on the audio clock (a lookahead scheduler), so it
 * keeps time even when the main thread stalls. The score feeds the music bus (the Music volume).
 */
type Chord = number[]; // MIDI notes, root first

const BPM = 88;
const STEP = 60 / BPM / 4; // a sixteenth
const CALM: Chord[] = [[50, 53, 57, 62], [46, 53, 58, 62], [41, 53, 57, 60], [48, 55, 60, 64]];
const TENSE: Chord[] = [[50, 53, 57, 62], [46, 53, 58, 62], [43, 55, 58, 62], [45, 52, 57, 61]];
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class Score {
  private out: GainNode;
  private dry: GainNode;
  private verbIn: GainNode;
  private delayIn: GainNode;
  private padBus: GainNode;
  private padLP: BiquadFilterNode;
  private timer: number | null = null;
  private nextT = 0;
  private step = 0;
  private prog: Chord[] = CALM;
  private padVoices: { oscs: OscillatorNode[]; gain: GainNode }[] = [];
  /** smoothed intensity (what the layers follow) and the target the game sets */
  private level = 0;
  private target = 0;
  private running = false;
  private noise: AudioBuffer;
  private gen = 0;
  private dyn: GainNode;

  constructor(private ctx: AudioContext, dest: AudioNode) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    comp.attack.value = 0.02;
    comp.release.value = 0.3;
    // dynamics: the whole score sits lower when calm and opens up in a fight
    this.dyn = ctx.createGain();
    this.dyn.gain.value = 0.6;
    this.out.connect(this.dyn).connect(comp).connect(dest);
    this.dry = ctx.createGain();
    this.dry.connect(this.out);
    // a long, dark hall
    const verb = ctx.createConvolver();
    verb.buffer = this.impulse(4.8);
    this.verbIn = ctx.createGain();
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.9;
    this.verbIn.connect(verb).connect(verbOut).connect(this.out);
    // dotted-eighth ping-pong delay
    this.delayIn = ctx.createGain();
    const dl = ctx.createDelay(2), dr = ctx.createDelay(2);
    dl.delayTime.value = STEP * 3;
    dr.delayTime.value = STEP * 6;
    const fb = ctx.createGain();
    fb.gain.value = 0.34;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    const pl = ctx.createStereoPanner(), pr = ctx.createStereoPanner();
    pl.pan.value = -0.7;
    pr.pan.value = 0.7;
    this.delayIn.connect(lp);
    lp.connect(dl).connect(pl).connect(this.out);
    lp.connect(dr).connect(pr).connect(this.out);
    dr.connect(fb).connect(lp);
    pl.connect(this.verbIn);
    // the pad bus: one low-pass for all chord voices (its cutoff opens with intensity)
    this.padBus = ctx.createGain();
    this.padLP = ctx.createBiquadFilter();
    this.padLP.type = 'lowpass';
    this.padLP.Q.value = 0.6;
    this.padLP.frequency.value = 700;
    this.padBus.connect(this.padLP);
    this.padLP.connect(this.dry);
    const send = ctx.createGain();
    send.gain.value = 0.85;
    this.padLP.connect(send).connect(this.verbIn);
    this.noise = this.noiseBuf(1);
  }

  /** stereo noise IR with an exponential tail, darker as it decays */
  private impulse(sec: number) {
    const sr = this.ctx.sampleRate, n = Math.floor(sec * sr);
    const b = this.ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const k = 0.35 + 0.6 * t; // the tail loses its highs
        lp = lp + (Math.random() * 2 - 1 - lp) * (1 - k);
        d[i] = lp * Math.pow(1 - t, 3.2) * (i < sr * 0.02 ? i / (sr * 0.02) : 1);
      }
    }
    return b;
  }
  private noiseBuf(sec: number) {
    const b = this.ctx.createBuffer(1, Math.floor(sec * this.ctx.sampleRate), this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  /** 0 calm … 1 heavy firefight */
  setIntensity(v: number) {
    this.target = Math.max(0, Math.min(1, v));
  }

  /** start (fade in over `fade` s) or stop (fade out) the score */
  play(on: boolean, fade = 6) {
    const t = this.ctx.currentTime;
    const g = this.out.gain;
    const gen = ++this.gen;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    if (on) {
      g.linearRampToValueAtTime(0.5, t + fade);
      if (!this.running) {
        this.running = true;
        this.nextT = t + 0.1;
        this.step = 0;
        this.level = this.target;
        this.timer = window.setInterval(() => this.schedule(), 25);
      }
    } else if (this.running) {
      g.linearRampToValueAtTime(0, t + fade);
      setTimeout(() => {
        // (started again while it was fading: keep playing)
        if (gen !== this.gen || !this.running) return;
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        this.running = false;
        this.releasePad(this.ctx.currentTime, 0.5);
      }, fade * 1000 + 200);
    }
  }
  get playing() {
    return this.running;
  }

  private schedule() {
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    // never fall far behind (a stalled tab): skip ahead instead of firing a backlog
    if (this.nextT < ctx.currentTime - 0.2) this.nextT = ctx.currentTime + 0.05;
    while (this.nextT < ctx.currentTime + 0.14) {
      // intensity follows the game: quick to rise, slow to settle
      const k = this.target > this.level ? 0.06 : 0.008;
      this.level += (this.target - this.level) * k;
      this.tick(this.step, this.nextT);
      this.step++;
      this.nextT += STEP;
    }
    // the pad's filter breathes open with the level, and the score as a whole comes forward
    this.padLP.frequency.setTargetAtTime(650 + this.level * 1900, ctx.currentTime, 0.8);
    this.dyn.gain.setTargetAtTime(0.55 + 0.6 * this.level, ctx.currentTime, 1.2);
  }

  private tick(step: number, t: number) {
    const L = this.level;
    const inBar = step % 16;
    const chordIdx = Math.floor(step / 32) % 4; // two bars a chord
    if (step % 128 === 0) this.prog = L > 0.62 ? TENSE : CALM; // the harmony changes on a phrase
    const chord = this.prog[chordIdx];
    if (step % 32 === 0) this.padChord(chord, t);
    // glints: rare, high, slow
    if (inBar === 0 && Math.random() < 0.28) this.glint(chord, t + Math.random() * 1.2);
    // pulse: eighth notes on the root
    if (L > 0.22 && step % 2 === 0) {
      const accent = inBar % 8 === 0 ? 1 : 0.7;
      this.sub(mtof(chord[0] - 12), t, 0.16 * accent * Math.min(1, (L - 0.22) / 0.25));
      // the pad ducks under each pulse (a gentle pump)
      const g = this.padBus.gain;
      g.setValueAtTime(1, t);
      g.linearRampToValueAtTime(1 - 0.28 * Math.min(1, L), t + 0.02);
      g.linearRampToValueAtTime(1, t + STEP * 1.8);
    }
    // arp: sixteenths on the chord tones, thinner when calm
    if (L > 0.12) {
      const pat = [0, 2, 1, 3, 2, 1, 3, 2, 0, 2, 1, 3, 1, 2, 3, 1];
      const density = 0.25 + 0.75 * Math.min(1, (L - 0.12) / 0.5);
      if (Math.random() < density * (inBar % 4 === 0 ? 1 : 0.7)) {
        const note = chord[pat[inBar]] + 24 + (inBar === 14 && L > 0.5 ? 12 : 0);
        this.pluck(mtof(note), t, 0.05 + 0.04 * L, (inBar % 2 ? -1 : 1) * 0.45);
      }
    }
    // drums
    if (L > 0.5) {
      const dk = Math.min(1, (L - 0.5) / 0.3);
      if (inBar === 0 || inBar === 10 || (L > 0.8 && inBar === 7)) this.drum(t, 0.55 * dk * (inBar === 0 ? 1 : 0.75));
      if (inBar % 2 === 1 || L > 0.85) this.hat(t, (inBar % 4 === 2 ? 0.09 : 0.05) * dk);
      if (L > 0.78 && (inBar === 4 || inBar === 12)) this.snare(t, 0.22 * Math.min(1, (L - 0.78) / 0.15));
    }
  }

  private releasePad(t: number, rel = 3.2) {
    for (const v of this.padVoices) {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(v.gain.gain.value, t);
      v.gain.gain.setTargetAtTime(0, t, rel / 3);
      for (const o of v.oscs) o.stop(t + rel + 0.5);
    }
    this.padVoices = [];
  }

  private padChord(ch: Chord, t: number) {
    const ctx = this.ctx;
    this.releasePad(t);
    const voices = [ch[0] - 12, ...ch.slice(1)];
    voices.forEach((m, i) => {
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(i === 0 ? 0.075 : 0.05, t + 2.2);
      const pan = ctx.createStereoPanner();
      pan.pan.value = (i / (voices.length - 1) - 0.5) * 0.9;
      gain.connect(pan).connect(this.padBus);
      const oscs: OscillatorNode[] = [];
      for (const det of [-8, 7]) {
        const o = ctx.createOscillator();
        o.type = i === 0 ? 'triangle' : 'sawtooth';
        o.frequency.value = mtof(m);
        o.detune.value = det + (Math.random() - 0.5) * 3;
        o.connect(gain);
        o.start(t);
        oscs.push(o);
      }
      this.padVoices.push({ oscs, gain });
    });
  }

  private glint(ch: Chord, t: number) {
    const ctx = this.ctx;
    const m = ch[1 + Math.floor(Math.random() * 3)] + 24;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = mtof(m);
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = mtof(m) * 2.001;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.022, t + 1.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 5);
    const g2 = ctx.createGain();
    g2.gain.value = 0.25;
    o.connect(g);
    o2.connect(g2).connect(g);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    g.connect(pan).connect(this.verbIn);
    pan.connect(this.delayIn);
    o.start(t);
    o2.start(t);
    o.stop(t + 5.1);
    o2.stop(t + 5.1);
  }

  private sub(f: number, t: number, a: number) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f * 1.5, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.03);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(a, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    o.connect(g).connect(this.dry);
    o.start(t);
    o.stop(t + 0.26);
  }

  private pluck(f: number, t: number, a: number, pan: number) {
    const ctx = this.ctx;
    const car = ctx.createOscillator(), mod = ctx.createOscillator();
    car.frequency.value = f;
    mod.frequency.value = f * 2;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(f * 2.2, t);
    mg.gain.exponentialRampToValueAtTime(f * 0.05, t + 0.35);
    mod.connect(mg).connect(car.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(a, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    car.connect(g).connect(p);
    p.connect(this.dry);
    p.connect(this.delayIn);
    const s = ctx.createGain();
    s.gain.value = 0.5;
    p.connect(s).connect(this.verbIn);
    car.start(t);
    mod.start(t);
    car.stop(t + 0.65);
    mod.stop(t + 0.65);
  }

  private drum(t: number, a: number) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(92, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(a, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    o.connect(g).connect(this.dry);
    const s = ctx.createGain();
    s.gain.value = 0.35;
    g.connect(s).connect(this.verbIn);
    o.start(t);
    o.stop(t + 0.62);
    // the skin: a short low noise thud
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'lowpass';
    bp.frequency.value = 900;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(a * 0.35, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    n.connect(bp).connect(ng).connect(this.dry);
    n.start(t, Math.random() * 0.5, 0.1);
  }

  private hat(t: number, a: number) {
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(a, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    const p = ctx.createStereoPanner();
    p.pan.value = 0.35;
    n.connect(hp).connect(g).connect(p).connect(this.dry);
    n.start(t, Math.random() * 0.8, 0.05);
  }

  private snare(t: number, a: number) {
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(a, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    n.connect(bp).connect(g);
    g.connect(this.dry);
    const s = ctx.createGain();
    s.gain.value = 0.6;
    g.connect(s).connect(this.verbIn);
    n.start(t, Math.random() * 0.6, 0.25);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(190, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.08);
    const og = ctx.createGain();
    og.gain.setValueAtTime(a * 0.6, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    o.connect(og).connect(this.dry);
    o.start(t);
    o.stop(t + 0.12);
  }
}
