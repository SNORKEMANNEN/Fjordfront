import { AudioEngine } from '../audio/AudioEngine';
import type { UI } from '../ui/UI';
import type { Flag } from './Domination';

/**
 * Radio net: HQ, the gunship pilot and the recon / fire-support operator share one channel, so
 * lines queue instead of talking over each other. Higher priority lines jump the queue; stale
 * lines (a "contested" call that is no longer true by the time it would play) expire.
 */
export type RadioSpk = 'ann' | 'pilot' | 'ops';
const CALLSIGN: Record<RadioSpk, string> = { ann: 'HQ', pilot: 'VALKYRIE 1-1', ops: 'OVERWATCH' };

interface Call { spk: RadioSpk; line: string; prio: number; expire: number; valid?: () => boolean }

export class Radio {
  private queue: Call[] = [];
  private busyUntil = 0;
  private lastLine = new Map<string, number>();

  constructor(private audio: AudioEngine, private ui: UI) {}

  clear() {
    this.queue.length = 0;
    this.busyUntil = 0;
    this.lastLine.clear();
  }

  /** Queue a line. `cooldown` suppresses the same line again for that many seconds. */
  say(spk: RadioSpk, line: string, time: number, o: { prio?: number; ttl?: number; cooldown?: number; valid?: () => boolean } = {}) {
    const key = `vo_${spk}_${line}`;
    if (!this.audio.has(key)) return false;
    const id = spk + line;
    if (time - (this.lastLine.get(id) ?? -99) < (o.cooldown ?? 0)) return false;
    if (this.queue.some((c) => c.spk === spk && c.line === line)) return false;
    this.lastLine.set(id, time);
    const prio = o.prio ?? 1;
    if (prio >= 3) this.queue.length = 0; // match result: drop everything else
    this.queue.push({ spk, line, prio, expire: time + (o.ttl ?? 7), valid: o.valid });
    this.queue.sort((a, b) => b.prio - a.prio);
    return true;
  }

  update(time: number) {
    if (time < this.busyUntil || !this.queue.length) return;
    let c: Call | undefined;
    while ((c = this.queue.shift())) {
      if (time <= c.expire && (!c.valid || c.valid())) break;
    }
    if (!c) return;
    const key = `vo_${c.spk}_${c.line}`;
    const n = this.audio.voiceText[key]?.length ?? 1;
    const variant = Math.floor(Math.random() * n);
    const buf = this.audio.bank[key]?.[variant];
    this.audio.play('radio', { gain: c.spk === 'pilot' ? 0.32 : 0.22, bus: 'ui', reverb: 0, rate: c.spk === 'pilot' ? 1.15 : 1 });
    this.audio.play(key, { gain: c.spk === 'pilot' ? 0.75 : 0.8, bus: 'ui', reverb: 0, prio: 3, variant });
    const dur = buf?.duration ?? 2;
    this.audio.music.duck(0.45, dur);
    const text = this.audio.voiceText[key]?.[variant];
    if (text) this.ui.subtitle(CALLSIGN[c.spk], text, c.spk === 'ann' ? 'hq' : 'radio', 0, dur + 0.6);
    this.busyUntil = time + dur + 0.35;
  }
}

/**
 * Context-aware HQ: watches the score race, flag ownership and the clock and calls out what a
 * squad leader would — close to winning / losing, contested flags, lead changes, comebacks, a
 * sweep of all three flags, the final thirty seconds. Every call has its own cooldown so the net
 * never turns into a running commentary.
 */
export class HQ {
  private t = 0;
  private lead = 0; // -1 / 0 / 1 from our side, with hysteresis
  private maxDeficit = 0;
  private said = new Set<string>();
  private allMine = false;
  private allTheirs = false;
  private contestT: Record<string, number> = {};

  reset() {
    this.t = 0;
    this.lead = 0;
    this.maxDeficit = 0;
    this.said.clear();
    this.allMine = this.allTheirs = false;
    this.contestT = {};
  }

  /** Is the match in its final stretch? (drives the tension music) */
  static tense(my: number, en: number, limit: number, timeLeft: number) {
    // "one flag away": at 1 pt / 5 s per flag, 80 % of the limit is ~2 minutes from the end with
    // one flag, a minute with two; also the last minute of a close game
    return Math.max(my, en) >= limit * 0.8 || (timeLeft < 60 && Math.abs(my - en) < limit * 0.2);
  }

  update(dt: number, time: number, s: { my: number; en: number; limit: number; timeLeft: number; flags: Flag[]; team: 0 | 1 }, say: (line: string, o?: { prio?: number; cooldown?: number; ttl?: number; valid?: () => boolean }) => void) {
    // flag contests react fast; the rest is evaluated once a second
    for (const f of s.flags) {
      if (f.owner !== s.team) continue;
      const enemyIn = f.inside[1 - s.team] > 0;
      if (enemyIn) {
        this.contestT[f.letter] = (this.contestT[f.letter] ?? 0) + dt;
        if (this.contestT[f.letter] > 1.5 && this.contestT[f.letter] - dt <= 1.5) say(`contest${f.letter}`, { prio: 2, cooldown: 25, ttl: 4, valid: () => f.owner === s.team && f.inside[1 - s.team] > 0 });
      } else this.contestT[f.letter] = 0;
    }
    this.t += dt;
    if (this.t < 1) return;
    this.t = 0;
    const { my, en, limit, timeLeft } = s;
    const diff = my - en;
    const once = (k: string, line = k, o?: { prio?: number; cooldown?: number }) => {
      if (this.said.has(k)) return;
      this.said.add(k);
      say(line, o);
    };
    // close to the end of the race
    if (my >= limit * 0.85 && my > en) once('closeWin', 'closeWin', { prio: 2 });
    if (en >= limit * 0.85 && en > my) once('closeLose', 'closeLose', { prio: 2 });
    // lead changes (with a margin so a one-point swing does not flip-flop)
    const lead = diff >= 8 ? 1 : diff <= -8 ? -1 : this.lead;
    // (only once the score means something; until then the lead is not "taken" yet)
    if (my + en > 30) {
      if (lead !== this.lead) {
        if (lead === 1) say(this.maxDeficit >= 30 ? 'comeback' : 'leadTaken', { cooldown: 30 });
        else if (lead === -1) say('leadLost', { cooldown: 30 });
      }
      this.lead = lead;
    }
    // comeback: we were well behind and have closed most of the gap
    this.maxDeficit = Math.max(this.maxDeficit, -diff);
    if (this.maxDeficit >= 35 && diff < 0 && -diff <= this.maxDeficit * 0.4) {
      say('comeback', { cooldown: 60 });
      this.maxDeficit = -diff; // a later collapse + recovery can call it again
    }
    if (my > 60 && my === en) say('tied', { cooldown: 90 });
    // all three flags
    const mine = s.flags.filter((f) => f.owner === s.team).length;
    const theirs = s.flags.filter((f) => f.owner === 1 - s.team).length;
    if (mine === 3 && !this.allMine) say('allFlags', { prio: 2, cooldown: 40 });
    if (theirs === 3 && !this.allTheirs) say('enemyAll', { prio: 2, cooldown: 40 });
    this.allMine = mine === 3;
    this.allTheirs = theirs === 3;
    if (timeLeft < 30 && timeLeft > 25) once('thirty', 'thirty', { prio: 2 });
  }
}
