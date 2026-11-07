import { Settings } from '../game/Settings';

/**
 * Music: one looping bed at a time (menu theme / tension underscore) with equal-power crossfades,
 * plus one-shot stings (victory / defeat) that duck whatever is playing.
 *
 * Tracks are original pieces generated for the game (Stable Audio 2.5 for the theme, the tension
 * bed and the victory sting; ElevenLabs sound generation for the defeat sting), mastered and made
 * seamlessly loopable by tools/music_build.py. The bus bypasses the in-game muffle / compressor
 * so low health and explosions do not pump the score.
 */
export type TrackId = 'menu' | 'tension' | 'victory' | 'defeat';
const FILES: Record<TrackId, string> = { menu: 'menu_theme.ogg', tension: 'tension.ogg', victory: 'victory.ogg', defeat: 'defeat.ogg' };
const LEVEL: Record<TrackId, number> = { menu: 0.85, tension: 0.42, victory: 0.95, defeat: 0.9 };

interface Voice { id: TrackId; src: AudioBufferSourceNode; gain: GainNode }

export class Music {
  out: GainNode;
  private bufs: Partial<Record<TrackId, AudioBuffer>> = {};
  private loading: Partial<Record<TrackId, Promise<AudioBuffer | null>>> = {};
  private bed: Voice | null = null;
  private want: TrackId | null = null;
  private duckG: GainNode;

  constructor(private ctx: AudioContext) {
    this.out = ctx.createGain();
    this.duckG = ctx.createGain();
    this.duckG.connect(this.out);
    this.out.connect(ctx.destination);
    this.applyVolume();
    Settings.onChange(() => this.applyVolume());
  }

  applyVolume() {
    const s = Settings.data;
    this.out.gain.setTargetAtTime(s.masterVolume * (s.musicVolume ?? 0.6), this.ctx.currentTime, 0.05);
  }

  private load(id: TrackId) {
    if (this.bufs[id]) return Promise.resolve(this.bufs[id]!);
    return (this.loading[id] ??= fetch(`${import.meta.env.BASE_URL}assets/music/${FILES[id]}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((a) => this.ctx.decodeAudioData(a))
      .then((b) => (this.bufs[id] = b))
      .catch(() => null));
  }

  /** Fetch + decode everything in the background (the menu theme first). */
  preload() {
    this.load('menu').then(() => Promise.all((['tension', 'victory', 'defeat'] as TrackId[]).map((t) => this.load(t))));
  }

  get current() {
    return this.want;
  }

  /** Crossfade the looping bed to `id` (or to silence with null). */
  async bedTo(id: TrackId | null, fade = 2.5) {
    if (this.want === id) return;
    this.want = id;
    const now = this.ctx.currentTime;
    const old = this.bed;
    this.bed = null;
    if (old) {
      old.gain.gain.cancelScheduledValues(now);
      old.gain.gain.setValueAtTime(old.gain.gain.value, now);
      old.gain.gain.linearRampToValueAtTime(0, now + fade);
      old.src.stop(now + fade + 0.05);
    }
    if (!id) return;
    const buf = await this.load(id);
    if (!buf || this.want !== id) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(LEVEL[id], t + fade);
    src.connect(gain).connect(this.duckG);
    src.start(t);
    this.bed = { id, src, gain };
  }

  /** One-shot sting; the bed is faded out underneath it. */
  async sting(id: 'victory' | 'defeat') {
    this.bedTo(null, 0.6);
    const buf = await this.load(id);
    if (!buf) return;
    const t = this.ctx.currentTime + 0.05;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = LEVEL[id];
    src.connect(g).connect(this.out);
    src.start(t);
  }

  /** Briefly pull the bed down (announcer lines, killstreak calls). */
  duck(amount = 0.5, hold = 1.5) {
    const t = this.ctx.currentTime;
    const p = this.duckG.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(1 - amount, t + 0.15);
    p.setValueAtTime(1 - amount, t + 0.15 + hold);
    p.linearRampToValueAtTime(1, t + 0.9 + hold);
  }
}
