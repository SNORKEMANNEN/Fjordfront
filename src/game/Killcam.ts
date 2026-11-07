import * as THREE from 'three';
import { Bot } from '../ai/Bot';

/**
 * Killcam: the last few seconds before your death, replayed from your killer's eyes.
 *
 * Every frame the recorder stores a compact kinematic snapshot of every soldier (position, body
 * yaw, aim yaw/pitch, speed, crouch, alive, death time, engaging) plus the local player, and every
 * shot fired. On death the replay re-poses the real bot models from those snapshots (no AI, no
 * physics — colliders never move) with a stand-in soldier model for the player, puts the camera
 * at the killer's eye looking down their recorded aim, and re-fires the recorded shots (tracers,
 * muzzle flashes, sound). The final half-second runs in slow motion. Afterwards every bot's
 * visual state is restored exactly.
 */
export const SNAP = 11; // floats per bot / player
const HZ = 60;
const KEEP = 6.5; // seconds kept

export interface ShotRec { t: number; id: number; origin: THREE.Vector3; dir: THREE.Vector3; muzzle: THREE.Vector3; def: string }

interface Frame { t: number; data: Float32Array }

export class KillcamRecorder {
  frames: Frame[] = [];
  shots: ShotRec[] = [];
  private pool: Float32Array[] = [];
  constructor(private slots: number) {}

  record(t: number, write: (a: Float32Array) => void) {
    const max = Math.ceil(KEEP * HZ);
    let data: Float32Array;
    if (this.frames.length >= max) data = this.frames.shift()!.data;
    else data = this.pool.pop() ?? new Float32Array(this.slots * SNAP);
    write(data);
    this.frames.push({ t, data });
    while (this.shots.length && t - this.shots[0].t > KEEP) this.shots.shift();
  }

  shot(s: ShotRec) {
    this.shots.push(s);
  }

  clear() {
    for (const f of this.frames) this.pool.push(f.data);
    this.frames.length = 0;
    this.shots.length = 0;
  }

  /** Copy the frames from [t0, t1] for playback. */
  window(t0: number, t1: number) {
    return {
      frames: this.frames.filter((f) => f.t >= t0 && f.t <= t1).map((f) => ({ t: f.t, data: f.data.slice() })),
      shots: this.shots.filter((s) => s.t >= t0 && s.t <= t1).map((s) => ({ ...s, origin: s.origin.clone(), dir: s.dir.clone(), muzzle: s.muzzle.clone() })),
    };
  }
}

/** Write a bot's replay state. */
export function writeBot(b: Bot, a: Float32Array, o: number) {
  const s = b.replayState();
  for (let i = 0; i < SNAP; i++) a[o + i] = s[i];
}

export interface Playback {
  frames: { t: number; data: Float32Array }[];
  shots: ShotRec[];
  /** index of the killer's slot (bots 0..n-1, player n) */
  killer: number;
  t: number;
  t0: number;
  t1: number;
  fired: Set<number>;
  saved: unknown[];
}

/** Interpolated slot state at replay time t. */
export function sample(p: Playback, slot: number, t: number, out: Float32Array) {
  const f = p.frames;
  let i = 1;
  while (i < f.length - 1 && f[i].t < t) i++;
  const A = f[Math.max(0, i - 1)], B = f[Math.min(f.length - 1, i)];
  const k = B.t > A.t ? THREE.MathUtils.clamp((t - A.t) / (B.t - A.t), 0, 1) : 0;
  const o = slot * SNAP;
  for (let j = 0; j < SNAP; j++) {
    const a = A.data[o + j], b = B.data[o + j];
    // angles (yaw 3, aimYaw 4) interpolate the short way round
    if (j === 3 || j === 4) {
      let d = b - a;
      d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      out[j] = a + d * k;
    } else if (j >= 7 && j !== 9) out[j] = k < 0.5 ? a : b; // flags
    else out[j] = a + (b - a) * k;
  }
  // teleports (respawns): no smearing across the map
  if (Math.hypot(B.data[o] - A.data[o], B.data[o + 2] - A.data[o + 2]) > 6) for (let j = 0; j < SNAP; j++) out[j] = (k < 0.5 ? A : B).data[o + j];
  return out;
}
