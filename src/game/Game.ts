import * as THREE from 'three';
import { Vegetation } from '../world/Vegetation';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Physics } from '../core/Physics';
import { Input } from '../core/Input';
import { MaterialLib } from '../render/Materials';
import { Pipeline } from '../render/Pipeline';
import { GpuTimer, PerfGovernor } from '../render/PerfGovernor';
import { compileWithProgress } from '../render/TextureBaker';
import { startTerrainHeights, terrainStats } from '../world/TerrainData';
import { detectHardware, presetForTier, HardwareInfo } from '../render/Hardware';
import { Environment } from '../world/Environment';
import { Terrain } from '../world/Terrain';
import { World } from '../world/World';
import { PlayerController } from '../player/PlayerController';
import { CameraRig } from '../player/CameraRig';
import { Settings } from './Settings';
import { SPAWNS, PLAY_HALF, landmarkAt, coastX, LANDMARKS, TUNNEL, TUNNEL_EXIT, tunnelShafts } from '../world/MapLayout';
import { Viewmodel, ActionType } from '../weapons/Viewmodel';
import { WeaponSystem, ShotRequest } from '../weapons/WeaponSystem';
import { makeWeaponMaterials, WeaponMats, WEAPON_BUILDERS, WeaponId } from '../weapons/WeaponModels';
import { makeArmMaterials } from '../weapons/Arms';
import { RiggedArms } from '../weapons/RiggedArms';
import { Effects } from '../fx/Effects';
import { WeaponDef, WEAPONS } from '../weapons/WeaponDefs';
import { NavGraph } from '../ai/NavGraph';
import { Bot } from '../ai/Bot';
import { Soldier, SoldierStyle } from '../character/Soldier';
import { Impostors } from '../character/Impostors';
import { roleFor } from '../character/SoldierMesh';
import { Combat } from './Combat';
import { Combatant, HitPart } from './Combatant';
import { SpawnSystem } from './SpawnSystem';
import { BotDirector } from '../ai/BotDirector';
import { Match } from './Match';
import { Domination, Flag, FlagEvent } from './Domination';
import { Explosives, lobVelocity, FRAG, MORTAR, MELEE, HELI, GrenadeKind, FUSE, SmokeCloud, Decoy, BARREL, VEHICLE } from './Explosives';
import { Deployables } from './Deployables';
import { Destruction } from '../world/Destruction';
import { ICONS } from '../ui/Icons';
import { Pickups } from './Pickups';
import { Killstreaks, STREAKS, StreakId } from './Killstreaks';
import { KillcamRecorder, writeBot, sample, SNAP, Playback } from './Killcam';
import { Ballistics } from './Ballistics';
import { Scope } from '../weapons/Scope';
import { AudioEngine } from '../audio/AudioEngine';
import { Radio, HQ, RadioSpk } from './Radio';
import { NightVision } from '../fx/NightVision';
import { PerfOverlay } from './PerfOverlay';
import { ThrowingKnives } from './ThrowingKnives';
import { Ambient } from '../world/Ambient';
import { KILL_TIMING, KnifeKill } from '../weapons/KnifeAnim';
import { makeThrowingKnife } from '../weapons/WeaponModels';
import { reportError, installErrorReport } from '../core/ErrorReport';
import { WeaponPreview } from '../ui/WeaponPreview';
import { UI, TacticalId, LethalId, LETHALS } from '../ui/UI';
import { TacticalMap, FIRE_REVEAL_RADIUS, MapState } from '../ui/TacticalMap';
import { NetGame } from '../net/NetGame';
import { NETF } from '../net/NetFlags';
import { Radar, Markers, RadarBlip } from '../ui/Radar';
import { T as MOVE_T, T_DEFAULTS } from '../player/PlayerController';
import { Weather } from '../fx/Weather';
import { patchSnow, bakeSnowCover } from '../fx/Snow';
import { Doors, Door, Mover } from '../world/Doors';
import { clamp, damp, RNG } from '../core/math';

type GameState = 'loading' | 'menu' | 'playing' | 'paused' | 'ended';
const TACTICAL_COUNT: Record<string, number> = { flash: 2, stun: 2, smoke: 1, stim: 1, snapshot: 1, decoy: 2 };
const LETHAL_COUNT: Record<string, number> = { frag: 2, tknife: 2, sticky: 2, claymore: 1, c4: 2 };
/** seconds for the field upgrade (trophy) to charge from empty */
const FIELD_TIME = 75;

/** The local player as a combat participant. */
class PlayerAvatar implements Combatant {
  id = 0;
  name = 'YOU';
  team: 0 | 1 = 0;
  isPlayer = true;
  health = 100;
  alive = true;
  kills = 0;
  deaths = 0;
  score = 0;
  assists = 0;
  stealth = 0;
  lastHitT = 99;
  onHurt: (from: Combatant | null, amt: number, dir: THREE.Vector3) => void = () => {};
  /** sideways head/shoulder offset while leaning (world m): bots see and shoot the leaned head */
  lean = new THREE.Vector3();
  constructor(public pc: PlayerController) {}
  position() {
    return this.pc.pos;
  }
  eye(out = new THREE.Vector3()) {
    return this.pc.eyePosition(out).add(this.lean);
  }
  lookDir(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pc.pitch);
    return out.set(-Math.sin(this.pc.yaw) * cp, Math.sin(this.pc.pitch), -Math.cos(this.pc.yaw) * cp);
  }
  chest(out = new THREE.Vector3()) {
    return out.copy(this.pc.pos).setY(this.pc.pos.y + this.pc.eyeHeight * 0.75);
  }
  hitTest(o: THREE.Vector3, d: THREE.Vector3, max: number) {
    if (!this.alive) return null;
    const p = this.pc.pos;
    const eh = this.pc.eyeHeight;
    const L = this.lean;
    const head = new THREE.Vector3(p.x + L.x, p.y + eh - 0.02, p.z + L.z);
    const hs = sphere(o, d, head, 0.16);
    if (hs !== null && hs <= max) return { dist: hs, part: 'head' as HitPart, point: o.clone().addScaledVector(d, hs) };
    for (let y = 0.25; y < eh - 0.2; y += 0.28) {
      // the torso bends with the lean: more offset the higher up
      const k = clamp((y - 0.7) / (eh - 0.7), 0, 1) * 0.85;
      const s = sphere(o, d, new THREE.Vector3(p.x + L.x * k, p.y + y, p.z + L.z * k), 0.3);
      if (s !== null && s <= max) return { dist: s, part: (y < 0.8 ? 'limb' : 'body') as HitPart, point: o.clone().addScaledVector(d, s) };
    }
    return null;
  }
  onDamaged(from: Combatant | null, amount: number, dir: THREE.Vector3) {
    this.lastHitT = 0;
    this.onHurt(from, amount, dir);
  }
}

function sphere(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, r: number) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
}

function smooth01(x: number) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

const NAMES: [string[], string[]] = [
  ['Haugen', 'Solberg', 'Nilsen', 'Berg', 'Lie', 'Dahl', 'Strand', 'Moen', 'Lund', 'Bakke', 'Eide', 'Vik'],
  ['Ulv', 'Ravn', 'Jerv', 'Gaupe', 'Orm', 'Varg', 'Isbjørn', 'Falk', 'Hauk', 'Elg', 'Rein', 'Bjørn'],
];

export class Game {
  renderer!: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, 1, 0.05, 12000);
  vmScene = new THREE.Scene();
  vmCamera = new THREE.PerspectiveCamera(48, 1, 0.01, 10);
  pipeline!: Pipeline;
  physics!: Physics;
  input: Input;
  mats!: MaterialLib;
  env!: Environment;
  terrain!: Terrain;
  world!: World;
  player!: PlayerController;
  avatar!: PlayerAvatar;
  rig!: CameraRig;
  vm!: Viewmodel;
  weapons!: WeaponSystem;
  wmats!: WeaponMats;
  fx!: Effects;
  nav!: NavGraph;
  bots: Bot[] = [];
  combat!: Combat;
  ballistics!: Ballistics;
  scope = new Scope(512);
  private scopeModel: unknown = null;
  private glints: THREE.Sprite[] = [];
  match!: Match;
  dom!: Domination;
  pickups!: Pickups;
  recorder!: KillcamRecorder;
  private ghost!: Bot;
  private legs!: Bot;
  private legsBuf = new Float32Array(SNAP);
  private killcam: Playback | null = null;
  private killcamSlot = -1;
  private deathTime = 0;
  winter = false;
  doors!: Doors;
  explosives!: Explosives;
  deployables!: Deployables;
  destruction: Destruction | null = null;
  /** 0..1 field upgrade (trophy) charge */
  fieldCharge = 0.5;
  /** combatant id -> revealed (snapshot grenade) until */
  revealed = new Map<number, number>();
  /** fake radar contacts from enemy decoys */
  private fakePings: { x: number; z: number; t: number }[] = [];
  /** set by the network layer: replicate an equipment action ('det', 'clay', 'trophy') */
  equipNet: ((a: string, d: Record<string, unknown>) => void) | null = null;
  streaks!: Killstreaks;
  frags = 2;
  private cookStart = -1;
  /** the loadout in use for the current life (UI choices apply on the next spawn) */
  loadout: { primary: WeaponId; secondary: WeaponId; tactical: TacticalId; lethal: LethalId } = { primary: 'k416', secondary: 'p80', tactical: 'flash', lethal: 'frag' };
  /** tactical equipment of the current life */
  tacCount = 2;
  private throwKind: GrenadeKind | 'tknife' = 'frag';
  /** knife takedown in progress (victim held, view turned onto them) */
  private knifeK: { victim: Bot; kind: KnifeKill; t: number; dur: number; lock: number; done: boolean; froze: boolean } | null = null;
  /** [V] held time while a gun is out: past the threshold the knife comes out */
  private vHoldT = -1;
  tknives!: ThrowingKnives;
  ambient!: Ambient;
  /** player status effects (seconds left) */
  blindT = 0;
  private blindK = 0;
  stunT = 0;
  stimT = 0;
  private designating = false;
  private laser: THREE.Mesh | null = null;
  private laserDot: THREE.Sprite | null = null;
  private spawnTime = 0;
  private firedSinceSpawn = false;
  audio!: AudioEngine;
  ui!: UI;
  weather!: Weather;
  state: GameState = 'loading';
  indoor = 0;
  clock = new THREE.Clock();
  time = 0;
  fps = 60;
  private fpsAcc = 0;
  private fpsN = 0;
  private respawnT = 0;
  private killerName = '';
  private killerWeapon = '';
  private deathCamTarget: THREE.Vector3 | null = null;
  private oobT = 0;
  private damageFx = 0;
  private flashFx = 0;
  private suppression = 0;
  private menuT = 0;
  private rng = new RNG(5);
  private slideAudio = 0;
  private lastBotShot = new Map<number, number>();
  radar!: Radar;
  markers!: Markers;
  private pings = new Map<number, number>(); // combatant id -> last unsuppressed shot time
  private spotted = new Map<number, number>(); // combatant id -> spotted until
  /**
   * Mid-match weather: once a match (most matches) the weather turns — a thick fog rolls in off
   * the fjord, or a snowstorm sweeps the valley. It builds over ~40 s, holds, then clears; HQ calls
   * it out on the way in and out.
   */
  private wxEvent = { kind: '' as '' | 'fog' | 'storm', at: 0, t: 0, fog: 0, called: false, cleared: false, prevWeather: '' };
  private scheduleWeatherEvent() {
    const forced = new URLSearchParams(location.search).get('wxevent');
    const roll = Math.random();
    this.wxEvent = { kind: forced === 'fog' || forced === 'storm' ? forced : roll < 0.4 ? 'fog' : roll < 0.75 ? 'storm' : '', at: forced ? 5 : 80 + Math.random() * 160, t: 0, fog: 0, called: false, cleared: false, prevWeather: '' };
  }
  private updateWeatherEvent(dt: number) {
    const e = this.wxEvent;
    if (!e.kind || this.state !== 'playing') return;
    e.t += dt;
    const t = e.t - e.at;
    if (t < 0) return;
    const BUILD = 40, HOLD = 110, CLEAR = 45;
    const k = t < BUILD ? t / BUILD : t < BUILD + HOLD ? 1 : Math.max(0, 1 - (t - BUILD - HOLD) / CLEAR);
    const s = k * k * (3 - 2 * k);
    if (!e.called) {
      e.called = true;
      this.announcer(e.kind === 'fog' ? 'fogIn' : 'snowIn');
      this.ui.notify(e.kind === 'fog' ? 'FOG ROLLING IN' : 'SNOWSTORM INBOUND', e.kind === 'fog' ? 'VISIBILITY DROPPING' : 'WHITEOUT CONDITIONS');
      if (e.kind === 'storm') {
        e.prevWeather = this.env.weather;
        if (this.env.weather !== 'snow') this.env.setWeather('snow');
      }
    }
    if (e.kind === 'fog') e.fog = s;
    else this.weather.storm = s;
    if (!e.cleared && t > BUILD + HOLD) {
      e.cleared = true;
      this.announcer('weatherClear');
    }
    if (t > BUILD + HOLD + CLEAR) {
      if (e.kind === 'storm' && e.prevWeather && e.prevWeather !== 'snow') this.env.setWeather(e.prevWeather as never);
      this.weather.storm = 0;
      e.fog = 0;
      e.kind = '';
    }
  }

  /**
   * Layered, distance-banded gunshot. Layers: the report (crack + body), the shooter's own
   * mechanical clack (your gun only), a low sub thump (close), and the outdoor tail (the valley
   * answering). Bands: NEAR < 25 m full and punchy, MID 25–90 m the crack softens and the tail
   * grows, FAR 90–260 m the distant recording with the highs gone, VERY FAR a dull rumble. Indoors
   * the tail is swapped for the room; suppressed guns lose the thump and most of the tail.
   */
  private gunshot(d: WeaponDef, pos: THREE.Vector3 | null, dist: number, occluded: boolean) {
    const sup = !!d.sound.suppressed;
    const out = 1 - this.indoor;
    const heavy = d.cls === 'Sniper' || d.cls === 'Shotgun' || d.cls === 'Marksman' ? 1.25 : d.cls === 'LMG' ? 1.15 : d.cls === 'Pistol' || d.cls === 'SMG' ? 0.85 : 1;
    if (!pos) {
      // ---- your own gun: close, dry and punchy
      this.audio.play(`shot_${d.id}`, { gain: sup ? 0.55 : 0.92, reverb: sup ? 0.15 : 0.32 + 0.12 * out, vary: 0.035, prio: 2 });
      if (!sup) this.audio.play(`low_${d.id}`, { gain: 0.32 * heavy * (0.7 + 0.3 * out), rate: 0.62, lowpass: 240, reverb: 0.05, vary: 0.04, prio: 1 });
      const mech = [`boltRelease@${d.id}`, `slideRelease@${d.id}`, `pumpForward@${d.id}`].find((k) => this.audio.has(k));
      if (mech && d.modes[0] !== 'pump' && d.modes[0] !== 'bolt') this.audio.play(mech, { gain: sup ? 0.22 : 0.1, rate: 1.35 + Math.random() * 0.1, reverb: 0, vary: 0.05, prio: 0 });
      if (!sup && out > 0.3) this.audio.play(`tail_${d.id}`, { gain: 0.3 * out * heavy, at: 0.06, lowpass: 2600, reverb: 0.6, rate: 0.96, vary: 0.04, prio: 0 });
      return;
    }
    const occ = occluded ? 0.7 : 1;
    const olp = occluded ? 1400 + 600 * (1 - this.indoor) : undefined;
    const ref = sup ? 4 : 10;
    if (dist < 25) {
      this.audio.play(`shot_${d.id}`, { pos, gain: (sup ? 0.4 : 1.0) * occ, ref, reverb: occluded ? 0.75 : 0.45, delay: true, vary: 0.05, lowpass: olp, prio: 1 });
      if (!sup && !occluded) this.audio.play(`low_${d.id}`, { pos, gain: 0.35 * heavy * (1 - dist / 25), ref: 8, rate: 0.62, lowpass: 240, reverb: 0.05, delay: true, prio: 0 });
    } else if (dist < 90) {
      const k = (dist - 25) / 65;
      this.audio.play(`shot_${d.id}`, { pos, gain: (sup ? 0.35 : 1.0) * occ, ref, reverb: occluded ? 0.75 : 0.5 + 0.2 * k, delay: true, vary: 0.05, lowpass: olp ?? 9000 - 4500 * k, prio: 1 });
      if (!sup && out > 0.3) this.audio.play(`tail_${d.id}`, { pos, gain: (0.25 + 0.35 * k) * out * occ, ref: 30, at: 0.05, reverb: 0.6, delay: true, lowpass: 3000, prio: 0 });
    } else if (dist < 260) {
      this.audio.play(`far_${d.id}`, { pos, gain: (sup ? 0.15 : 0.9) * heavy * occ, ref: 40, reverb: 0.65, delay: true, vary: 0.06, lowpass: olp ?? 2600 - 900 * ((dist - 90) / 170), prio: 0 });
    } else if (!sup) {
      this.audio.play(`far_${d.id}`, { pos, gain: 0.7 * heavy, ref: 80, reverb: 0.8, delay: true, vary: 0.08, rate: 0.9, lowpass: 900, prio: 0 });
    }
  }

  /** Zipline ride: the trolley carries the player; jump lets go, the end sets you down. */
  private zipAudio = 0;
  private updateZipline(dt: number) {
    const z = this.world.zips;
    const pl = this.player;
    if (!z.ride) {
      pl.zipFeet = null;
      this.zipAudio = Math.max(0, this.zipAudio - dt * 4);
      return;
    }
    if (!this.avatar.alive || this.input.wasPressed('jump')) {
      // let go: keep the trolley's momentum, a little hop
      const r = z.ride;
      z.ride = null;
      pl.zipFeet = null;
      pl.vel.copy(r.line.dir).multiplyScalar(r.v * r.sign * 0.85);
      pl.vel.y = 2.5;
      return;
    }
    const r = z.update(dt);
    if (!r) return;
    if (r.ended) {
      pl.zipFeet = null;
      pl.body.teleport(r.ended);
      pl.vel.copy(r.vel).multiplyScalar(0.35).setY(0);
      this.audio.play('land', { gain: 0.5, reverb: 0.05 });
      this.rig.onLand(4);
      return;
    }
    pl.zipFeet = r.feet;
    pl.vel.copy(r.vel);
    this.zipAudio = Math.min(1, this.zipAudio + dt * 4);
    // a light sway on the trolley
    if (Math.random() < dt * 2) this.rig.onRecoil(0, 0, (Math.random() - 0.5) * 0.04);
  }

  /** Shot-out lights: the first fixture / street lamp along the ray (before any wall) breaks. */
  private shootLights(o: THREE.Vector3, d: THREE.Vector3) {
    const wl = this.physics.raycast(o, d, 160);
    const h = this.world.shootable.raycast(o, d, wl ? wl.distance : 160);
    if (!h) return;
    const it = h.item;
    this.world.shootable.breakLight(it);
    const p = it.c;
    this.fx.impact(p, d.clone().negate(), 'glass', d, false);
    this.fx.flashPop(p);
    this.audio.play(this.audio.has('glassShatter') ? 'glassShatter' : 'imp_glass_heavy', { pos: p, gain: it.street ? 0.9 : 0.6, rate: it.street ? 1.0 : 1.35, ref: 4, reverb: 0.3, vary: 0.08 });
    this.audio.play('imp_metal_light', { pos: p, gain: 0.35, rate: 1.9, ref: 3, reverb: 0.1 });
  }

  /**
   * Indoor / outdoor gunshot echo. Every 0.6 s the space around the listener is probed (8 rays, up
   * to 450 m: walls, houses, hillsides, the mountain walls of the fjord). Outdoors each shot sends
   * back its strongest reflections from those surfaces — delayed by the round trip, panned from the
   * surface, darker with distance, the far mountains rolling a second or more later. Indoors the
   * room reverb carries it plus a tight slap off the walls.
   */
  private echoProbe: { dir: THREE.Vector3; d: number; terrain: boolean }[] = [];
  private echoT = 0;
  private updateEchoProbe(dt: number) {
    this.echoT -= dt;
    if (this.echoT > 0) return;
    this.echoT = 0.6;
    const o = this.camera.position;
    this.echoProbe.length = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.2;
      const dir = new THREE.Vector3(Math.cos(a), 0.06, Math.sin(a)).normalize();
      const h = this.physics.raycast(o, dir, 450);
      if (h) this.echoProbe.push({ dir, d: h.distance, terrain: h.info.tag === 'terrain' });
    }
  }
  private gunEcho(src: THREE.Vector3, d: WeaponDef, loud: number) {
    if (d.sound.suppressed || loud <= 0.02 || d.cls === 'Melee') return;
    const key = this.audio.has(`far_${d.id}`) ? `far_${d.id}` : `shot_${d.id}`;
    const big = d.cls === 'Sniper' || d.cls === 'Marksman' || d.cls === 'Shotgun' ? 1.25 : d.cls === 'LMG' ? 1.12 : d.cls === 'Pistol' || d.cls === 'SMG' ? 0.8 : 1;
    if (this.indoor > 0.5) {
      const near = this.echoProbe.filter((e) => e.d < 12).sort((a, b) => a.d - b.d)[0];
      this.audio.play(`shot_${d.id}`, { gain: 0.16 * loud * big, at: near ? (2 * near.d) / 343 : 0.014, lowpass: 3200, reverb: 0.35, rate: 0.96, prio: 0, vary: 0.03 });
      return;
    }
    const cam = this.camera.position;
    const cands = this.echoProbe
      .filter((e) => e.d > 14)
      .map((e) => ({ e, s: (e.terrain ? 1.35 : 1) * (40 / (e.d + 40)) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 3);
    for (const { e, s } of cands) {
      const P = cam.clone().addScaledVector(e.dir, e.d);
      const at = P.distanceTo(src) / 343; // source → surface; the engine adds surface → listener
      this.audio.play(key, { pos: P, ref: e.d, gain: Math.min(0.5, 0.42 * s) * loud * big, at, delay: true, lowpass: Math.max(500, 5200 / (1 + e.d / 90)), reverb: 0.25, rate: 0.97 - Math.min(0.08, e.d / 4000), vary: 0.04, prio: 0 });
    }
  }

  /** world pings (location markers) */
  private worldPings: { pos: THREE.Vector3; until: number }[] = [];
  /** full-screen tactical map [M] and the waypoint set on it */
  tmap!: TacticalMap;
  /** multiplayer (host / join, chat, commands) */
  netg!: NetGame;
  private waypoint: THREE.Vector3 | null = null;
  private vmCamRoll = 0;
  private radarT = 0;
  testMode = new URLSearchParams(location.search).has('test');

  constructor(public canvas: HTMLCanvasElement, public uiRoot: HTMLDivElement) {
    this.input = new Input(canvas);
  }

  // ================================================================ boot
  async boot() {
    this.ui = new UI(this.uiRoot, {
      onPlay: () => this.startMatch(),
      onMultiplayer: () => this.netg.showPanel(),
      onResume: () => this.resume(),
      onQuit: () => this.toMenu(),
      onRestart: () => {
        if (this.netg?.isClient) return this.ui.notify('WAITING FOR THE HOST', 'THE HOST STARTS THE NEXT MATCH');
        this.startMatch();
      },
      onLoadout: () => this.onLoadoutChanged(),
      onSettings: () => this.applySettings(),
    });
    const bootT0 = performance.now();
    const bootLog: [string, number][] = ((window as any).__bootLog = []);
    const mark = (s: string) => bootLog.push(['  · ' + s, Math.round(performance.now() - bootT0)]);
    (window as any).__bootMark = mark;
    const step = async (p: number, s: string) => {
      bootLog.push([s, Math.round(performance.now() - bootT0)]);
      this.ui.setLoading(p, s);
      await new Promise((r) => setTimeout(r, 16));
    };
    // the terrain height field starts computing right away, in parallel workers (or from cache)
    const terrainP = startTerrainHeights();
    // network assets (also preloaded by index.html) download while everything else starts up
    const assetsP = Promise.all([
      new THREE.TextureLoader().loadAsync(import.meta.env.BASE_URL + 'assets/textures/waternormals.jpg'),
      new GLTFLoader().loadAsync(import.meta.env.BASE_URL + 'assets/models/fps_arms.glb').catch(() => null),
    ]);
    await step(0.03, 'Starting renderer');
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: this.testMode });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    // shadow maps are rendered once per frame (renderFrame sets needsUpdate). With autoUpdate on,
    // three re-renders every shadow map inside *every* renderer.render() call — the scope, the
    // water reflection and the AO pass each paid for a full shadow pass again
    r.shadowMap.autoUpdate = false;
    this.scene.matrixWorldAutoUpdate = false; // updated once per frame in renderFrame
    this.renderer = r;
    // first launch (or a different GPU): start from a preset that suits the hardware
    this.hw = detectHardware(r.getContext() as WebGL2RenderingContext);
    const urlQ = new URLSearchParams(location.search).get('quality');
    if (Settings.data.autoQualityGpu === 'keep') {
      Settings.data.autoQualityGpu = this.hw.gpu;
      Settings.save();
    } else if (Settings.data.autoQuality && !urlQ && Settings.data.autoQualityGpu !== this.hw.gpu) {
      Settings.data.autoQualityGpu = this.hw.gpu;
      Settings.applyPreset(presetForTier(this.hw.tier));
    }
    console.log(`[hw] ${this.hw.gpu || 'unknown GPU'} · tier ${this.hw.tier} · ${this.hw.cores} threads · parallel compile ${this.hw.parallelCompile} · preset ${Settings.data.quality}`);
    this.mats = new MaterialLib(r);
    // texture bakes are recorded while the world is built and compiled/run together further down
    this.mats.baker.defer = true;
    await step(0.06, 'Initialising physics');
    this.physics = await Physics.create();
    this.audio = new AudioEngine();
    this.radio = new Radio(this.audio, this.ui);
    this.audio.music.preload();
    // sound loads in the background (fetch + decode run off the main thread): the menu doesn't wait
    // for ~400 recordings; anything played before they're in is simply skipped
    this.audioLoad = this.audio.load().then(
      () => bootLog.push(['  · audio ready (background)', Math.round(performance.now() - bootT0)]),
      (e) => reportError('audio', e),
    );
    // browsers start audio only after a gesture: the menu theme begins on the first click / key
    const wake = () => this.audio.resume();
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    await step(0.1, 'Loading assets');
    const [waterNormals, armsGltf] = await assetsP;
    await step(0.14, 'Lighting the fjord');
    this.env = new Environment(r, this.scene, waterNormals);
    await step(0.18, 'Shaping terrain');
    Vegetation.multiDraw = this.renderer.extensions.has('WEBGL_multi_draw') && !location.search.includes('nomultidraw');
    const heights = await terrainP.catch(() => undefined);
    mark(`terrain heights (${terrainStats.source}, ${Math.round(terrainStats.ms)} ms)`);
    this.world = new World(this.mats, this.physics, this.scene, () => {}, heights);
    this.terrain = this.world.terrain;
    mark('world built');
    this.vmScene.environment = this.scene.environment;
    (this.vmScene as any).environmentIntensity = 0.75;
    this.physics.step();
    await step(0.48, 'Surveying routes');
    this.nav = new NavGraph(this.physics, this.terrain, this.world.buildings.nav, this.world.buildings.navPoints);
    mark('nav');
    this.director = new BotDirector(this.nav, () => this.rng.next());
    // doors are hung after the nav graph is built so routes run through doorways
    this.doors = new Doors(this.world.buildings.doors, this.physics, this.scene, this.world.buildings.materials);
    this.doors.onOpen = (d, kicked, by) => this.onDoorOpen(d, kicked, by);
    this.doors.onSlam = (d, speed) => {
      const tip = new THREE.Vector3(d.spec.width, 1.1, 0).applyMatrix4(d.pivot.matrixWorld);
      this.audio.play('imp_plank', { pos: tip, gain: Math.min(1.2, 0.5 + speed * 0.06), ref: 5, reverb: 0.4, vary: 0.08, rate: 0.8 });
      if (tip.distanceTo(this.camera.position) < 5) this.rig.addTrauma(0.08);
    };
    await step(0.56, 'Arming squads');

    // ---- player ----
    const sp = SPAWNS[0];
    const start = new THREE.Vector3(sp.x, this.terrain.heightAt(sp.x, sp.z) + 0.2, sp.z);
    this.rig = new CameraRig(this.camera);
    this.player = new PlayerController(this.physics, this.input, {
      onJump: () => {
        this.rig.onJump();
        this.vm?.jumpImpulse();
        this.audio.play('jump', { gain: 0.6, reverb: 0.05 });
      },
      onLand: (s) => {
        this.rig.onLand(s);
        this.vm?.landImpulse(s);
        if (s > 3) this.audio.play('land', { gain: Math.min(1, s / 9), reverb: 0.08 });
        this.footstepSound(this.player.pos, 1, true);
        // a hard landing while running: tuck and roll through it (camera dips and rolls, less damage)
        const hs = this.player.horizSpeed();
        if (s > 8.5 && hs > 3.5) {
          const side = Math.random() < 0.5 ? -1 : 1;
          this.rig.onRecoil(-0.55, 0.05 * side, 0.45 * side);
          this.audio.play('cloth', { gain: 0.6, reverb: 0 });
          if (s > 15 && this.avatar.alive) this.hurtPlayer((s - 15) * 6, 'Fall damage');
        } else if (s > 15 && this.avatar.alive) this.hurtPlayer((s - 15) * 9, 'Fall damage');
      },
      onSlideStart: () => {
        this.slideAudio = 1;
        this.rig.onSlideStart();
        this.vm?.slideImpulse();
      },
      onSlideEnd: () => {
        this.slideAudio = 0;
        this.rig.onSlideEnd();
      },
      onMantle: (hgt) => {
        this.rig.onMantle(hgt);
        this.audio.play('mantle', { gain: 0.7, reverb: 0.05 });
      },
      onFootstep: (s) => this.footstepSound(this.player.pos, s, true),
      onStance: () => this.audio.play('cloth', { gain: 0.5, reverb: 0 }),
      onTacSprint: () => this.audio.play('tac', { gain: 0.7, reverb: 0 }),
      onDive: () => {
        this.rig.onJump();
        this.rig.addTrauma(0.12);
        this.vm?.jumpImpulse();
        this.audio.play('jump', { gain: 0.8, reverb: 0.05, rate: 0.9 });
        this.audio.play('cloth', { gain: 0.6, reverb: 0 });
      },
      onDiveLand: (s) => {
        this.rig.onLand(Math.max(6, s * 1.3));
        this.rig.addTrauma(0.35);
        this.vm?.landImpulse(Math.max(8, s * 1.4));
        this.audio.play('land', { gain: 1.0, reverb: 0.08, rate: 0.85 });
        this.audio.play('imp_punch', { gain: 0.4, reverb: 0.05, rate: 0.7 });
        this.audio.play('cloth', { gain: 0.7, reverb: 0 });
      },
    }, start);
    this.avatar = new PlayerAvatar(this.player);
    this.avatar.onHurt = (from, amt) => this.onPlayerHurt(from, amt);
    this.scene.add(this.camera);
    this.camera.layers.enable(1); // layer 1: fine detail skipped by the water reflection pass

    // ---- weapons & fx ----
    this.fx = new Effects(this.scene, this.mats.baker);
    this.fx.groundHeight = (x, z) => this.groundHeightAt(x, z);
    this.fx.onShellBounce = (p, kind) => {
      if (kind === 'mag' || kind === 'magSmall') this.audio.play('imp_plate_light', { pos: p, gain: kind === 'mag' ? 0.8 : 0.6, ref: 2, reverb: 0.1, rate: kind === 'mag' ? 0.9 : 1.15 });
      else {
        // casings: recorded impacts chosen by what they land on (and brass vs shotgun hull)
        const hit = this.physics.raycast(new THREE.Vector3(p.x, p.y + 0.2, p.z), new THREE.Vector3(0, -1, 0), 0.6);
        let surf: string = hit ? hit.info.surface : 'grass';
        if (hit && hit.info.tag === 'terrain') surf = this.terrain.surfaceAt(p.x, p.z);
        const hull = kind === 'shotgun';
        const big = kind === 'big';
        const pick: [string, number, number] =
          surf === 'metal' ? ['imp_metal_light', 0.5, hull ? 1.3 : 2.4]
          : surf === 'wood' || surf === 'woodFloor' ? ['imp_wood', 0.4, hull ? 1.5 : 2.3]
          : surf === 'grass' || surf === 'dirt' || surf === 'sand' || surf === 'snow' ? ['imp_dirt', 0.22, 2.2]
          : surf === 'water' ? ['imp_water', 0.25, 1.6]
          : ['imp_tin', hull ? 0.28 : 0.42, hull ? 1.4 : big ? 2.0 : 2.7];
        this.audio.play(pick[0], { pos: p, gain: pick[1] * (big ? 1.2 : 1), ref: 1, reverb: 0.05, rate: pick[2], vary: 0.12 });
      }
    };
    const glass = this.world.buildings.glass;
    glass.onFrameBreak = (p) => {
      this.audio.play('imp_plank', { pos: p, gain: 1.0, ref: 4, reverb: 0.3, vary: 0.08, rate: 0.85 });
      this.audio.play('imp_wood', { pos: p, gain: 0.8, ref: 4, reverb: 0.25, vary: 0.1 });
      this.alertBots(p, 20, -1);
    };
    this.player.windowVault = (feet, fwd) => this.windowVault(feet, fwd);
    glass.onCrack = (p) => this.audio.play(this.audio.has('glassCrack') ? 'glassCrack' : 'imp_glass', { pos: p, gain: 0.8, ref: 3, reverb: 0.25, vary: 0.08 });
    glass.onBreak = (p) => {
      this.audio.play(this.audio.has('glassShatter') ? 'glassShatter' : 'imp_glass_heavy', { pos: p, gain: 1.0, ref: 4, reverb: 0.35, vary: 0.06, prio: 2 });
      this.alertBots(p, 18, -1);
    };
    this.wmats = makeWeaponMaterials(this.mats);
    // loadout screen: studio preview + silhouette thumbnails of every gun
    this.ui.previewFactory = () => new WeaponPreview((id) => WEAPON_BUILDERS[id as WeaponId](this.wmats).root);
    this.vm = new Viewmodel(this.vmScene, makeArmMaterials(this.mats));
    if (armsGltf) {
      try {
        const am = await RiggedArms.prepareMaterial(armsGltf);
        this.vm.useRig(new RiggedArms(armsGltf, am));
      } catch (e) {
        console.warn('rigged arms unavailable, using procedural arms', e);
      }
    }
    this.weapons = new WeaponSystem(this.input, this.player, this.rig, this.vm, this.wmats, {
      onShot: (req) => this.onPlayerShot(req),
      onSound: (n, d) => this.weaponFoley(n, d),
      onDryFire: () => this.audio.play(this.audio.has(`dry@${this.weapons.cur.def.id}`) ? `dry@${this.weapons.cur.def.id}` : 'dry', { gain: 0.7, reverb: 0 }),
      onKnife: (k) => this.knifeAttack(k),
    }, this.fx.muzzleTex, this.vmCamera);
    this.applyLoadout();
    this.vm.addItem('tknife', makeThrowingKnife(this.wmats));
    const crowSpots = [[42, 62], [-48, -24], [84, -34], [-30, 90], [60, -110]].map(([x, z]) => new THREE.Vector3(x, 0, z)).filter((v) => this.terrain.heightAt(v.x, v.z) > 1.5);
    this.ambient = new Ambient(this.scene, (x, z) => this.terrain.heightAt(x, z), this.world.buildings.chimneys, crowSpots);
    this.ambient.onTakeoff = (p) => {
      if (p.distanceTo(this.camera.position) < 60) this.audio.play('cloth', { pos: p, gain: 0.9, rate: 1.6, ref: 6, reverb: 0.2, vary: 0.1 });
    };
    this.tknives = new ThrowingKnives(this.scene, makeThrowingKnife(this.wmats), this.physics, () => this.match?.players ?? [],
      (victim, by, point, dir, part) => this.tknifeHit(victim, by, point, dir, part),
      (point, normal, surface) => {
        this.fx.impact(point, normal, surface as never, normal.clone().negate(), false);
        this.audio.play(surface === 'metal' ? 'imp_metal_light' : surface === 'wood' || surface === 'woodFloor' ? 'imp_wood' : 'imp_generic', { pos: point, gain: 0.5, rate: 1.4, ref: 3, reverb: 0.1 });
      });

    // ---- combat, match, bots ----
    this.combat = new Combat(this.physics, this.fx, {
      onKill: (k, v, def, hs, wb) => this.onKill(k, v, def.name, hs, wb),
      onDamage: (v, a, amt, part, dir, through) => {
        if (a === this.avatar && v.health > 0) {
          // the marker says what you hit: head (gold), limb (small, thin), through cover (grey),
          // and one that leaves them nearly dead (bright, a little bigger)
          this.ui.hitmarker(false, part === 'head', amt, part === 'limb' ? 'limb' : through ? 'through' : v.health < 30 ? 'low' : '');
          this.audio.play(part === 'head' ? 'headshot' : 'hit', { gain: part === 'limb' ? 0.5 : 0.7, rate: part === 'limb' ? 1.12 : 1, bus: 'ui', reverb: 0, vary: 0.025, prio: 3 });
          // the meat of it: a body thud under the tick, a crunchier one on the head
          this.audio.play('imp_punch', { gain: part === 'head' ? 0.2 : part === 'limb' ? 0.07 : 0.13, bus: 'ui', reverb: 0, rate: part === 'head' ? 1.1 : 1.4 });
          if (part === 'head') this.audio.play('imp_flesh', { gain: 0.22, bus: 'ui', reverb: 0, rate: 1.5 });
        }
        if (!v.isPlayer) this.audio.play('imp_flesh', { pos: v.chest(new THREE.Vector3()), gain: 0.7, ref: 3 });
        this.bloodSpatter(v, part, dir, amt);
      },
      onImpact: (hit, def, shooter) => {
        const s = hit.info.tag === 'terrain' ? this.terrain.surfaceAt(hit.point.x, hit.point.z) : hit.info.surface;
        this.fx.impact(hit.point, hit.normal, s, new THREE.Vector3(0, -1, 0), def.cls === 'Sniper');
        const name = s === 'metal' ? 'imp_metal' : s === 'wood' || s === 'woodFloor' ? 'imp_wood' : s === 'glass' ? 'imp_glass' : s === 'water' ? 'imp_water' : s === 'grass' || s === 'dirt' || s === 'sand' || s === 'snow' ? 'imp_dirt' : 'imp_concrete';
        const d = hit.point.distanceTo(this.camera.position);
        if (d < 80) {
          const g = shooter === this.avatar ? 0.55 : 0.8;
          this.audio.play(name, { pos: hit.point, gain: g, ref: 3 });
          if (name === 'imp_concrete') this.audio.play('imp_rock', { pos: hit.point, gain: g * 0.6, ref: 3, rate: 1.3 });
          if (name === 'imp_metal' && def.cls === 'Sniper') this.audio.play('imp_metal_heavy', { pos: hit.point, gain: g, ref: 4 });
        }
      },
      onBulletPass: () => {},
    });
    // faction camouflage (baked with the other procedural textures)
    SoldierStyle.init(this.mats.baker);
    this.match = new Match([this.avatar], this.physics, this.terrain);
    this.match.spawns = new SpawnSystem(this.physics, this.terrain, this.nav, () => this.time);
    this.spawnBots();
    this.match.players.push(...this.bots);
    this.recorder = new KillcamRecorder(this.bots.length + 1);
    // stand-in soldier for the player in killcam replays
    this.ghost = new Bot(100, 'YOU', 0, { role: 'rifleman', seed: 4242 }, WEAPON_BUILDERS['k416'](this.wmats), 'k416', {
      physics: this.physics, nav: this.nav, combatants: () => [], fire: () => {}, footstep: () => {}, objectiveFor: () => new THREE.Vector3(), difficulty: 0,
    });
    this.ghost.body.setEnabled(false);
    this.ghost.root.visible = false;
    this.scene.add(this.ghost.root);
    // the player's own legs (seen when looking down) and their shadow
    this.legs = new Bot(101, 'legs', 0, { role: 'rifleman', seed: 4242 }, WEAPON_BUILDERS['p80'](this.wmats), 'p80', {
      physics: this.physics, nav: this.nav, combatants: () => [], fire: () => {}, footstep: () => {}, objectiveFor: () => new THREE.Vector3(), difficulty: 0,
    });
    this.legs.body.setEnabled(false);
    this.legs.makeLegsOnly();
    this.legs.root.visible = false;
    this.scene.add(this.legs.root);
    this.match.onEnd = (w) => this.onMatchEnd(w);
    this.combat.combatants = this.match.players;
    this.dom = new Domination(this.scene, this.nav, this.terrain);
    this.dom.onEvent = (e) => this.onFlagEvent(e);
    this.match.spawns.bias = (p, team) => this.flagSpawnBias(p, team);
    this.setupExplosives();
    this.setupDestruction();
    this.pickups = new Pickups(this.scene);
    // night vision (before the shader warm-up: its IR illuminator is a permanent light)
    this.nvg = new NightVision(this.scene, this.physics);
    for (const b of this.bots) this.nvg.addIRTargets(b.root);
    this.weather = new Weather(this.scene, this.mats.baker, (x, z) => this.terrain.topAt(x, z));
    this.env.onLighting = () => {
      this.vmScene.environment = this.scene.environment;
      (this.vmScene as any).environmentIntensity = 0.75 * (1 - this.env.night * 0.6);
    };
    this.ballistics = new Ballistics(this.combat, this.fx);
    // scope glint sprites for enemy snipers
    const glintTex = this.mats.baker.raw('fx.glint', `void main(){ vec2 p = vUv*2.0-1.0; float r = length(p);
      float a = exp(-r*r*30.0) + exp(-abs(p.y)*40.0) * exp(-abs(p.x)*3.0) * 0.6 + exp(-abs(p.x)*40.0) * exp(-abs(p.y)*3.0) * 0.6;
      gl_FragColor = vec4(vec3(1.0), clamp(a, 0.0, 1.0)); }`, 128, false);
    for (let i = 0; i < 3; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glintTex, color: new THREE.Color(6, 5.5, 4.5), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
      sp.visible = false;
      sp.renderOrder = 40;
      this.scene.add(sp);
      this.glints.push(sp);
    }

    // ---- radar & markers ----
    this.radar = new Radar(this.ui.hudEl, this.terrain);
    this.markers = new Markers(this.ui.hudEl);
    this.tmap = new TacticalMap(this.ui.root, this.terrain);
    this.ui.root.insertBefore(this.tmap.el, this.ui.hudEl.nextSibling); // over the HUD, under the menus
    this.tmap.ziplines = this.world.zips.lines.map((l) => ({ a: { x: l.a.x, z: l.a.z }, b: { x: l.b.x, z: l.b.z } }));
    this.tmap.onPing = (x, z) => this.mapPing(x, z);
    this.tmap.onWaypoint = (p) => this.setWaypoint(p);
    this.ui.tuning = { values: MOVE_T as unknown as Record<string, number>, defaults: T_DEFAULTS as unknown as Record<string, number> };

    // ---- render pipeline ----
    this.pipeline = new Pipeline(r, this.scene, this.camera, this.vmScene, this.vmCamera);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    await step(0.72, 'Painting surfaces');
    await this.mats.baker.flush((k) => this.ui.setLoading(0.72 + k * 0.12, 'Painting surfaces'));
    await step(0.84, 'Letting the snow settle');
    patchSnow(this.scene);
    bakeSnowCover(r, this.scene, [this.env.sky.mesh, this.env.water, this.world.veg.grass, ...this.weather.objects(), ...this.glints]);
    await step(0.86, 'Compiling shaders');
    await this.warmShaders((k) => this.ui.setLoading(0.86 + k * 0.13, 'Compiling shaders'));

    // far soldiers as billboards (atlas rendered now that the camo textures exist)
    this.impostors = new Impostors(r, this.scene, [WEAPON_BUILDERS.k416(this.wmats), WEAPON_BUILDERS.hval47(this.wmats)]);
    installErrorReport();
    this.gpuTimer = new GpuTimer(this.renderer);
    this.governor = new PerfGovernor(this.pipeline, this.gpuTimer);
    this.governor.onNotice = (msg) => this.ui.notify('AUTO GRAPHICS', msg.toUpperCase());
    this.perf = new PerfOverlay(this.renderer, document.body, this.gpuTimer);
    this.perf.extra = () => {
      const p = this.pipeline, g = this.governor;
      return `<div>${p.rw}×${p.rh} px (${Math.round(Settings.data.renderScale * p.dynScale * 100)} %)</div>` +
        `<div>display ${Math.round(1000 / g.refreshMs)} Hz · target ${Math.round(1000 / g.stats.target)} fps</div>` +
        `<div>${Settings.data.quality}${Settings.data.autoQuality ? ' (auto)' : ''} · ${this.hw.gpu.replace(/ANGLE \(|\)$/g, '').slice(0, 48)}</div>`;
    };
    this.perf.visible = !!Settings.data.perfOverlay;
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'F3') return;
      e.preventDefault();
      this.perf.visible = !this.perf.visible;
      Settings.data.perfOverlay = this.perf.visible;
      Settings.save();
    });
    // a lost GPU context (driver reset, GPU watchdog) is restored instead of killing the tab
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('[render] WebGL context lost — waiting for it to come back');
      reportError('gpu', new Error('WebGL context lost (GPU driver reset or out of video memory)'));
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      console.warn('[render] WebGL context restored');
      // render-target contents don't survive a context loss: re-bake every procedural texture
      try {
        this.mats.baker.rebakeAll();
      } catch (e) {
        reportError('gpu', e);
      }
      this.pipeline.setSize(window.innerWidth, window.innerHeight);
    });

    // ---- input & lifecycle ----
    this.canvas.addEventListener('click', () => {
      this.audio.resume();
      if (this.state === 'playing' && !this.input.locked) this.input.lock();
    });
    this.input.onLockChange = (locked) => {
      if (!locked) this.setMapOpen(false);
      if (!locked && this.state === 'playing') this.pauseGame();
    };
    window.addEventListener('pointerdown', () => this.audio.resume());

    bootLog.push(['ready', Math.round(performance.now() - bootT0)]);
    this.ui.hideLoading();
    this.toMenu();
    this.clock.start();
    this.netg = new NetGame(this);
    const joinCode = new URLSearchParams(location.search).get('join');
    if (joinCode) this.netg.showPanel(joinCode);
    if (!this.testMode) r.setAnimationLoop((t: number) => this.frame(t));
    // automated tests start matches instantly: let them hear everything (players get the menu
    // first and the sounds finish loading behind it)
    if (this.testMode) await this.audioLoad;
    (window as any).__ready = true;
  }

  private spawnBots() {
    // 12v12: eleven bots beside the player, twelve against. Same class mix on both sides
    // (rifles carry the line, SMGs + shotguns clear buildings, two marksmen per side)
    const mix: WeaponId[] = ['k416', 'mp7', 'ks17', 'pump12', 'skv338', 'dmr14', 'kr98', 'lmg', 'db12', 'ums45', 'stille9', 'hval47'];
    const ids: WeaponId[][] = [mix.slice(0, 11), mix];
    let id = 1;
    const diff = { recruit: 0, regular: 0.5, veteran: 1 }[Settings.data.botDifficulty];
    for (const team of [0, 1] as const) {
      ids[team].forEach((wid, i) => {
        const model = WEAPON_BUILDERS[wid](this.wmats);
        const bot = new Bot(id++, NAMES[team][i], team, { role: roleFor(WEAPONS[wid].cls, wid), seed: id * 37 + team * 11 }, model, wid, {
          physics: this.physics,
          nav: this.nav,
          combatants: () => this.match.players,
          fire: (s, o, d, def, muzzle) => this.onBotShot(s as Bot, o, d, def, muzzle),
          footstep: (p, sp) => this.footstepSound(p, Math.min(1, sp / 6), false),
          objectiveFor: (t, _from, b) => this.objectiveFor(t, b),
          animInterval: (b) => this.animInterval(b),
          viewDist: () => 160 / (1 + this.wxEvent.fog * 3.5 + this.weather.storm * 3 + this.weather.inBank * 2),
          // character-controller sweeps: every frame only up close; 30 Hz further out (drawn
          // dead-reckoned in between), 15-20 Hz off screen
          moveInterval: (b) => { const ai = this.animInterval(b); return ai >= 1 / 8 ? 1 / 15 : ai >= 1 / 15 ? 1 / 20 : b.position().distanceTo(this.camera.position) < 14 ? 0 : 1 / 30; },
          dwellAt: (p, b) => {
            const f = this.dom?.flagAt(p);
            // Domination: hold the zone until it flips (re-evaluated every few seconds), or guard it a while
            if (f) return f.owner !== b.team ? 2.5 + this.rng.next() : 1.5 + this.rng.next() * 2.5;
            return this.nav.nearest(p, 2.5, false)?.indoor ? 1.2 + this.rng.next() * 1.8 : 0;
          },
          preferObjective: (b) => {
            const k = this.director.kindOf(b.id);
            return k === 'capture' || k === 'defend';
          },
          pathOpts: (b) => this.director.pathOpts(b.id, b.team, this.bots.filter((o) => o.alive).map((o) => ({ id: o.id, team: o.team, goal: o.goalPos }))),
          throwGrenade: (b, at) => {
            const from = b.eye(new THREE.Vector3());
            const v = lobVelocity(from, at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4)));
            // some soldiers carry sticky grenades instead of frags
            const sticky = b.id % 4 === 1;
            this.explosives.throw(b, from, sticky ? v.multiplyScalar(1.05) : v, sticky ? FUSE.sticky : 2.6 + Math.random() * 0.9, sticky ? 'sticky' : 'frag');
          },
          throwTactical: (b, at, kind) => {
            const from = b.eye(new THREE.Vector3());
            // a few carry decoys (thrown off to one side of the fight) or snapshot grenades
            const k: GrenadeKind = b.id % 6 === 4 ? 'decoy' : b.id % 6 === 5 ? 'snapshot' : kind;
            let to = at.clone();
            if (k === 'decoy') {
              const side = new THREE.Vector3(at.z - from.z, 0, from.x - at.x).normalize().multiplyScalar((Math.random() < 0.5 ? -1 : 1) * 10);
              to = from.clone().lerp(at, 0.55).add(side);
            }
            const v = lobVelocity(from, to.add(new THREE.Vector3((Math.random() - 0.5) * 3, 0, (Math.random() - 0.5) * 3)));
            this.explosives.throw(b, from, v, FUSE[k] + Math.random() * 0.3, k);
          },
          smokeBlocks: (a, b) => this.explosives?.smokeBlocks(a, b) ?? false,
          voice: (b, line) => this.botVoice(b, line),
          callout: (from, pos) => {
            for (const m of this.bots) if (m !== from && m.alive && m.team === from.team && m.position().distanceTo(from.position()) < 70 && !m.target) m.hear(pos);
          },
          difficulty: diff,
          night: () => this.env.night > 0.5,
          animEvent: (b, ev, p) => this.botAnimEvent(b, ev, p),
        });
        // soldiers are fine detail for the water reflection (layer 1: main + scope cameras and
        // the sun's shadow camera see it, the reflection camera does not)
        bot.root.traverse((o) => o.layers.set(1));
        this.scene.add(bot.root);
        this.bots.push(bot);
      });
    }
  }

  /** Recent gunfire (position, time) used to steer bots toward the fight. */
  private hotspots: { p: THREE.Vector3; t: number }[] = [];
  noteGunfire(p: THREE.Vector3) {
    this.ambient?.scare(p);
    const last = this.hotspots[this.hotspots.length - 1];
    if (last && last.p.distanceTo(p) < 12 && this.time - last.t < 1) return;
    this.hotspots.push({ p: p.clone(), t: this.time });
    if (this.hotspots.length > 40) this.hotspots.shift();
    this.match.spawns?.noteAction(p);
  }

  /** Next roaming waypoint for a bot: the team director hands out spread-out missions (see BotDirector). */
  private objectiveFor(team: 0 | 1, bot?: Bot) {
    const aggro = 0.55 + 0.35 * ({ recruit: 0, regular: 0.5, veteran: 1 }[Settings.data.botDifficulty]);
    const hotspots = this.hotspots.filter((h) => this.time - h.t < 15).map((h) => h.p);
    if (!bot) {
      const lm = LANDMARKS[Math.floor(this.rng.next() * LANDMARKS.length)];
      return this.nav.nearest(new THREE.Vector3(lm.x, 0, lm.z))?.p.clone() ?? new THREE.Vector3(lm.x, 0, lm.z);
    }
    return this.director.next({ id: bot.id, team, pos: bot.position() }, {
      mates: this.bots.filter((b) => b.team === team && b.alive).map((b) => ({ id: b.id, pos: b.position() })),
      enemies: this.match.players.filter((p) => p.team !== team && p.alive),
      hotspots,
      aggro,
      flags: this.dom.flags.map((f) => ({
        pos: f.pos,
        owner: f.owner,
        radius: f.radius,
        letter: f.letter,
        contested: f.contested,
        enemiesNear: this.match.players.filter((p) => p.alive && p.team !== team && p.position().distanceTo(f.pos) < 35).length,
      })),
    });
  }
  director!: BotDirector;
  private frustum = new THREE.Frustum();
  private frustumM = new THREE.Matrix4();
  private frustumFrame = -1;
  private frameNo = 0;
  /** Animation LOD for bots: full rate within 45 m and on screen, 1/2 rate to 90 m, 1/4 beyond or off-screen. */
  private animInterval(b: Bot) {
    if (this.frustumFrame !== this.frameNo) {
      this.frustumFrame = this.frameNo;
      this.camera.updateMatrixWorld();
      this.frustum.setFromProjectionMatrix(this.frustumM.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    }
    const p = b.position();
    const d = p.distanceTo(this.camera.position);
    const onScreen = this.frustum.containsPoint(this.tmpAnimP.set(p.x, p.y + 1, p.z));
    // 12v12 budget: full rate only where you can tell the difference (hit tests follow the body
    // between updates, so a lower pose rate never costs accuracy)
    if (d < 14) return 0;
    if (!onScreen) return d < 30 ? 1 / 10 : 1 / 6;
    if (d < 26) return 0;
    return d < 50 ? 1 / 30 : d < 90 ? 1 / 20 : 1 / 12;
  }
  private tmpAnimP = new THREE.Vector3();

  applySettings() {
    if (this.perf) this.perf.visible = !!Settings.data.perfOverlay;
    this.pipeline.rebuild();
    this.pipeline.setSize(window.innerWidth, window.innerHeight);
    this.env.applyShadowRes();
    const diff = { recruit: 0, regular: 0.5, veteran: 1 }[Settings.data.botDifficulty];
    for (const b of this.bots) (b as any).w.difficulty = diff;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vmCamera.aspect = w / h;
    this.vmCamera.updateProjectionMatrix();
    this.pipeline.setSize(w, h);
  }

  // ================================================================ states
  toMenu() {
    this.state = 'menu';
    this.audio.music.bedTo('menu', 2.5);
    this.radio.clear();
    this.input.unlock();
    this.ui.showMenu(true);
    this.ui.showHUD(false);
    this.ui.showPause(false);
    this.ui.hideEnd();
    this.ui.showDeath(false);
    this.ui.setScoreboard(false);
    for (const b of this.bots) {
      b.alive = false;
      b.root.visible = false;
      b.body.setEnabled(false);
    }
  }

  startMatch() {
    this.world?.shootable?.repairAll();
    this.tknives?.clear();
    if (this.knifeK?.froze) this.player.frozen = false;
    this.knifeK = null;
    this.audio.resume();
    this.ui.showMenu(false);
    this.ui.hideEnd();
    this.ui.showPause(false);
    this.ui.showHUD(true);
    this.applyLoadout();
    this.match.reset();
    const homes = this.match.spawns!.ensureLayout();
    this.dom.myTeam = this.avatar.team;
    this.dom.setup(homes[0], homes[1]);
    this.explosives.clear();
    this.deployables.clear();
    this.destruction?.reset();
    this.fieldCharge = 0.5;
    this.revealed.clear();
    this.streaks.reset();
    this.radio.clear();
    this.hq.reset();
    this.world.buildings.glass.reset();
    for (const w of this.world.buildings.windows) w.broken = false;
    this.nvg.reset();
    this.audio.music.bedTo(null, 3.5);
    this.pickups.clear();
    this.firstBlood = true;
    this.lastKiller = null;
    this.deathStreak = 0;
    const w = Settings.data.weather;
    const mv = Settings.data.mapVariant ?? 'random';
    this.env.setTime(Settings.data.timeOfDay ?? 'dynamic');
    const blue = this.env.blueHour > 0;
    // the blue hour is a winter thing: deep blue snow, warm windows (random map: mostly winter)
    const winter = mv === 'winter' || (mv === 'random' && this.rng.next() < (blue ? 0.85 : 0.4));
    this.winter = winter;
    this.env.winter = winter;
    this.terrain.winter = winter;
    SoldierStyle.setWinter(winter);
    this.world.veg.grass.visible = !winter;
    const r = this.rng.next();
    let wx: 'clear' | 'overcast' | 'rain' | 'snow' = w === 'auto'
      ? blue ? (r < 0.6 ? 'clear' : r < 0.85 ? 'snow' : 'overcast')
      : winter ? (r < 0.5 ? 'snow' : r < 0.75 ? 'overcast' : 'clear') : r < 0.25 ? 'rain' : r < 0.37 ? 'snow' : r < 0.67 ? 'overcast' : 'clear'
      : w;
    if (winter && wx === 'rain') wx = 'snow';
    this.env.setWeather(wx);
    this.weather.reset(winter, wx);
    this.weather.storm = 0;
    this.scheduleWeatherEvent();
    this.vmScene.environment = this.scene.environment;
    this.match.initialSpawns = true;
    this.respawnPlayer();
    for (const b of this.bots) {
      const s = this.match.pickSpawn(b.team);
      b.spawn(s.pos, s.yaw);
    }
    this.match.initialSpawns = false;
    this.state = 'playing';
    this.minuteCalled = false;
    window.setTimeout(() => this.announcer('start'), 900);
    this.netg?.onMatchStart();
    this.nightNagT = 0;
    // night op: HQ tells you to get your goggles on
    window.setTimeout(() => {
      if (this.env.night > 0.5 && !this.nvg.active) this.radio.say('ann', 'nightOps', this.time, { prio: 2, ttl: 12 });
    }, 4200);
    this.input.lock();
  }

  pauseGame() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.ui.showPause(true);
    this.ui.setScoreboard(false);
  }

  resume() {
    this.ui.showPause(false);
    this.state = 'playing';
    this.input.lock();
    this.clock.getDelta();
  }

  private minuteCalled = false;
  private onMatchEnd(w: 0 | 1 | -1) {
    this.netg?.onMatchEnd(w);
    this.announcer(w === this.avatar.team ? 'win' : 'lose');
    this.audio.music.sting(w === this.avatar.team ? 'victory' : 'defeat');
    this.state = 'ended';
    this.input.unlock();
    this.ui.showDeath(false);
    this.ui.showEnd(w, this.avatar.team, this.match.snapshot(), this.match.scores, this.match.teamNames);
  }

  private respawnPlayer() {
    // your own legs / killcam stand-in wear your side's uniform
    this.legs?.setTeam(this.avatar.team);
    this.ghost?.setTeam(this.avatar.team);
    const s = this.match.pickSpawn(this.avatar.team);
    this.player.teleport(s.pos, s.yaw);
    this.player.dead = false;
    this.avatar.alive = true;
    this.avatar.health = 100;
    this.applyLoadout();
    this.weapons.enabled = true;
    this.frags = LETHAL_COUNT[this.loadout.lethal] ?? 2;
    this.cookStart = -1;
    this.killcamSlot = -1;
    this.blindT = this.stunT = this.stimT = 0;
    this.nvg.reset();
    this.spawnTime = this.time;
    this.firedSinceSpawn = false;
    this.endDesignate(false);
    this.ui.showDeath(false);
    this.deathCamTarget = null;
    this.oobT = 0;
  }

  // ================================================================ loop
  private lastFrameT = 0;
  frame(now = performance.now()) {
    const dt = Math.min(this.clock.getDelta(), 1 / 20);
    this.fpsAcc += dt;
    this.fpsN++;
    if (this.fpsAcc > 0.5) {
      this.fps = this.fpsN / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsN = 0;
    }
    const t0 = performance.now();
    try {
      this.tick(dt);
    } catch (e) {
      reportError('tick', e);
    }
    const t1 = performance.now();
    this.gpuTimer.begin();
    try {
      this.renderFrame(dt);
    } catch (e) {
      reportError('render', e);
    }
    this.gpuTimer.end();
    this.perf.frame(t1 - t0, performance.now() - t1);
    this.input.endFrame();
    // background work: soldiers' nearer detail levels (a few ms a frame, mostly while in the menu)
    Soldier.idleBuild(this.state === 'playing' ? 2 : 6);
    // frame-time governor: dynamic resolution (internal targets only) + last-resort effect drops
    const interval = this.lastFrameT ? now - this.lastFrameT : 0;
    this.lastFrameT = now;
    this.governor.frame(interval, this.state === 'playing' && !this.killcam);
    if (this.governor.applied) {
      this.governor.applied = false;
      this.pipeline.rebuild();
      this.env.applyShadowRes();
    }
  }

  /** Automation: advance n frames at fixed dt (test mode). */
  step(n = 1, dt = 1 / 60, render = true) {
    for (let i = 0; i < n; i++) {
      this.tick(dt);
      if (render && i === n - 1) this.renderFrame(dt);
      this.input.endFrame();
    }
    return { pos: this.player.pos.toArray().map((v) => +v.toFixed(2)), mode: this.player.mode, stance: this.player.stance, state: this.state };
  }

  private tick(dt: number) {
    this.time += dt;
    this.frameNo++;
    if (this.tmap?.open && this.state !== 'playing') this.setMapOpen(false);
    this.radio.update(this.time);
    if (this.state === 'menu' || this.state === 'loading') {
      this.menuCamera(dt);
      this.env.update(dt, this.camera);
      this.world.update(this.time, this.camera.position, this.env);
      this.weather.update(dt, this.camera.position, this.env.weather);
      this.vm.root.visible = false;
      return;
    }
    if (this.state === 'paused' && NETF.active) {
      // online the world keeps going while your pause menu is open (you just stop playing)
      this.input.enabled = false;
      this.state = 'playing';
      this.time -= dt; // (the nested tick advances the clock)
      this.frameNo--;
      try {
        this.tick(dt);
      } finally {
        this.state = 'paused';
        this.input.enabled = true;
      }
      return;
    }
    if (this.state === 'paused' || this.state === 'ended') {
      this.env.update(dt, this.camera);
      this.weather.update(dt, this.camera.position, this.env.weather);
      return;
    }
    if (this.input.wasPressed('map')) this.setMapOpen(!this.tmap.open);
    if (this.tmap.open) {
      // the map takes the mouse (virtual cursor, wheel, clicks); the player can still move
      this.tmap.handleInput(this.input);
      this.input.mouseDX = this.input.mouseDY = this.input.wheel = 0;
    }
    if (this.killcam) {
      this.updateKillcam(dt);
      this.updateMapView(dt);
      return;
    }
    const inp = this.input;
    // ---------------- player ----------------
    const w = this.weapons;
    const a = this.avatar;
    const sens = (w.ads > 0.5 ? (w.scopeActive ? (Settings.data.scopeSensitivity ?? 0.2) : Settings.data.adsSensitivity) : 1) * (this.stunT > 0 ? 0.3 : 1);
    if (a.alive && !this.tmap.open) this.player.look(inp.mouseDX, inp.mouseDY, sens);
    this.updateZipline(dt);
    this.player.update(dt);
    this.updateDoors(dt);
    this.physics.step();
    w.update(dt, this.indoor);
    const def = w.cur.def;
    // canted laser aim under goggles: no optic in front of the eye, so (almost) no zoom
    w.cant = this.nvg.active && !!w.cur.model.sockets.laser ? 1 : 0;
    this.cantZoom = damp(this.cantZoom, w.cant, 6, dt);
    const zoom = def.adsZoom + (1.08 - def.adsZoom) * this.cantZoom;
    this.updateDoorPeek(dt);
    this.updateBipod(dt);
    const ck = this.vm.camKick;
    if (ck.lengthSq() > 0) {
      this.rig.onRecoil(ck.x, ck.y, ck.z);
      ck.set(0, 0, 0);
    }
    this.vmCamRoll += (this.vm.camRoll - this.vmCamRoll) * (1 - Math.exp(-dt * 8));
    if (a.alive) this.rig.update(dt, this.player, zoom, w.ads, -this.peekLean * this.leanRollMul + this.vmCamRoll);
    this.viewmodelFov(w.ads);
    this.nvgFrame(dt);
    if (!a.alive) {
      this.vm.root.visible = false;
      this.deathCam(dt);
    }
    const zipHere = a.alive && !this.world.zips.ride ? this.world.zips.reachable(this.camera.position, new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion)) : null;
    const c4Tap = inp.wasPressed('spot') && a.alive && this.myC4().length > 0 && this.time - this.lastUseTap < 0.35;
    if (inp.wasPressed('spot')) this.lastUseTap = this.time;
    if (c4Tap) {
      this.lastUseTap = -9;
      this.startDetonate();
    } else if (inp.wasPressed('spot') && a.alive) {
      // F: clip onto a zipline in reach, else open / close the door you are looking at, else spot
      const d = this.doorFocus();
      if (zipHere && !this.player.mantle && !this.player.ladder) {
        this.world.zips.attach(zipHere.line, zipHere.s, new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion), this.player.vel);
        this.audio.play('imp_metal_light', { gain: 0.6, rate: 0.8, reverb: 0.05 });
        this.audio.play('cloth', { gain: 0.5, reverb: 0 });
      } else if (d) this.useDoor(d);
      else this.trySpot();
    }
    this.ui.interactHint(a.alive && this.state === 'playing' ? (this.world.zips.ride ? '[SPACE] LET GO' : zipHere ? '[F] ZIPLINE' : this.doorFocus() ? (Math.abs(this.doorFocus()!.target) > 0.5 ? '[F] CLOSE DOOR' : '[F] OPEN DOOR') : '') : '');
    if (a.alive && this.weapons.enabled) this.playerActions(dt);
    if (inp.wasPressed('ping') && a.alive) this.ping();
    if (inp.wasPressed('scoreboard')) this.ui.setScoreboard(true, this.match.snapshot(), this.match.teamNames);
    if (inp.wasReleased('scoreboard')) this.ui.setScoreboard(false);

    // ---------------- health & bounds ----------------
    a.lastHitT += dt;
    if (a.alive) {
      if (a.lastHitT > 4 && a.health < 100) a.health = Math.min(100, a.health + dt * 30);
      const p = this.player.pos;
      const out = Math.abs(p.x) > PLAY_HALF || Math.abs(p.z) > PLAY_HALF || (p.y < 0.4 && p.x < coastX(p.z) - 8);
      if (out) {
        this.oobT = this.oobT > 0 ? this.oobT - dt : 5;
        if (this.oobT <= 0.02) this.hurtPlayer(200, 'Out of bounds');
      } else this.oobT = 0;
      a.stealth = this.player.stance !== 'stand' ? 1 : 0;
    } else {
      this.respawnT -= dt;
      this.ui.showDeath(true, this.killerName, this.killerWeapon, this.respawnT + (this.killcamSlot >= 0 ? 4 : 0));
      if (this.respawnT <= 0 && this.match.phase === 'live') {
        if (this.killcamSlot >= 0 && this.startKillcam()) return;
        this.respawnPlayer();
      }
    }

    // ---------------- bots ----------------
    for (const b of this.bots) {
      if (b.netPuppet) {
        // owned by another machine: posed from the network
        b.netUpdate(dt);
        continue;
      }
      if (b.netDisabled) continue;
      if (b.alive && b.health <= 0) {
        b.alive = false;
        b.kill(new THREE.Vector3(0, 0, 1));
      }
      if (!b.alive) this.director.forget(b.id);
      b.update(dt, this.time);
      if (!b.alive && b.respawnT <= 0 && this.match.phase === 'live') {
        const s = this.match.pickSpawn(b.team);
        b.spawn(s.pos, s.yaw);
      }
    }
    if (!this.netg?.isClient) {
      // (a client mirrors the host's clock, flags and score instead)
      this.match.update(dt);
      this.match.addPoints(this.dom.update(dt, this.match.players, this.time));
    }
    this.netg?.update(dt);
    if (!this.minuteCalled && this.match.timeLeft < 60 && this.match.phase === 'live') {
      this.minuteCalled = true;
      this.announcer('minute');
    }
    if (this.match.phase === 'live') {
      const me = this.avatar.team;
      const sc = this.match.scores;
      this.hq.update(dt, this.time, { my: sc[me], en: sc[1 - me], limit: this.match.scoreLimit, timeLeft: this.match.timeLeft, flags: this.dom.flags, team: me }, (line, o) => this.radio.say('ann', line, this.time, o));
      // tension underscore while either side is within reach of the win
      const tense = HQ.tense(sc[0], sc[1], this.match.scoreLimit, this.match.timeLeft);
      if (tense && this.audio.music.current !== 'tension') this.audio.music.bedTo('tension', 5);
      else if (!tense && this.audio.music.current === 'tension') this.audio.music.bedTo(null, 5);
    }
    this.recordFrame();
    this.updateDominationHUD(dt);

    // ---------------- world & fx ----------------
    this.env.update(dt, this.camera);
    // viewmodel key light follows the real sun / moon relative to the camera
    this.vm.daylight = Math.max(Math.min(1.2, this.env.sun.intensity / 3.0), 0.42 * this.env.blueHour);
    this.vm.lighting.color.copy(this.env.sun.color);
    this.vm.lighting.position.copy(this.env.lightDir).applyQuaternion(this.camera.quaternion.clone().invert());
    this.fx.update(dt);
    this.world.buildings.glass.update(dt);
    this.ballistics.update(dt);
    this.explosives.update(dt);
    this.runTimers();
    if (this.vm.detonatorOut && (!this.avatar.alive || !this.myC4().length || this.weapons.reloading || this.weapons.switching || this.player.ladder || this.player.mantle || this.player.tactical || this.vm.action?.type === 'nvg')) this.vm.detonatorOut = false;
    this.deployables.update(dt, this.camera.position);
    if (this.destruction) {
      this.destruction.update(dt, this.camera.position);
      if (this.avatar.alive && this.player.sprinting) this.destruction.bodyPush(this.player.pos, this.player.vel);
    }
    this.updateEquipFx(dt);
    if (this.avatar.alive && this.state === 'playing') this.fieldCharge = Math.min(1, this.fieldCharge + dt / FIELD_TIME);
    const picked = this.tknives.update(dt, this.avatar.alive ? { pos: this.player.pos.clone().setY(this.player.pos.y + 0.3), team: this.avatar.team, owner: this.avatar } : null);
    if (picked > 0 && this.loadout.lethal === 'tknife') {
      this.frags = Math.min(2, this.frags + picked);
      this.audio.play('imp_metal_light', { gain: 0.4, rate: 1.8, reverb: 0 });
      this.ui.notify('THROWING KNIFE', 'PICKED UP');
    }
    this.updateKnife(dt);
    this.ambient.update(dt, this.camera.position, this.weather.wind, (p, v) => this.fx.smokePuff(p, v, this.winter ? [0.62, 0.62, 0.64] : [0.5, 0.5, 0.52], 0.55 + Math.random() * 0.25, 5 + Math.random() * 2));
    this.streaks.update(dt, this.time, (team) => this.enemyFocus(team));
    this.updateStreakWorld(dt);
    this.updateGlints();
    this.updateRadar(dt);
    this.world.update(this.time, this.camera.position, this.env);
    this.weather.update(dt, this.camera.position, this.env.weather, window.innerHeight);
    this.ballistics.wind.copy(this.weather.wind);
    this.updateWeatherEvent(dt);
    this.updateEchoProbe(dt);
    this.env.setFogBoost(1 + this.weather.inBank * 7 + this.wxEvent.fog * 9 + this.weather.storm * 6);
    this.audio.windGust = Math.min(1, this.weather.windSpeed / 12);
    this.updateIndoor(dt);
    this.audio.indoor = this.indoor;
    this.audio.setListener(this.camera);
    const p = this.player.pos;
    this.audio.ambience(dt, this.camera.position, Math.max(0, p.x - coastX(p.z)), this.env.weather, p.y);
    this.worldAmbience(dt);
    this.audio.loop('slide', Math.max(this.slideAudio * 0.55, this.world.zips.ride ? 0.35 + 0.25 * this.zipAudio : this.zipAudio * 0.5));
    this.damageFeedback(dt);
    this.updateStatusEffects(dt);
    this.updateLegs(dt);
    if (this.pickups.update(dt, a.alive ? this.player.pos : null, this.time) > 0) this.collectSupplies();
    this.audio.hurt = a.alive ? clamp((45 - a.health) / 45, 0, 1) : 0;
    this.damageFx = damp(this.damageFx, a.alive ? clamp((100 - a.health) / 100, 0, 1) * 0.9 : 0.6, 6, dt);
    this.flashFx = Math.max(0, this.flashFx - dt * 4);
    this.suppression = Math.max(0, this.suppression - dt * 0.8);

    // ---------------- HUD ----------------
    const s = w.cur;
    this.ui.updateHUD({
      health: a.health,
      mag: s.mag,
      reserve: s.reserve,
      magSize: s.def.mag,
      weapon: s.def.name.toUpperCase(),
      mode: s.mode === 'auto' ? 'AUTO' : s.mode === 'semi' ? 'SEMI' : s.mode === 'burst' ? 'BURST' : s.mode === 'pump' ? 'PUMP' : 'BOLT',
      spread: w.lastSpread,
      ads: w.ads,
      scores: this.match.scores,
      limit: this.match.scoreLimit,
      time: this.match.timeLeft,
      heading: this.player.yaw,
      location: landmarkAt(p.x, p.z),
      reloading: w.reloading,
      sprint: this.player.sprinting ? 1 : 0,
      fps: this.fps,
      outOfBounds: this.oobT,
      hint: w.scopeActive ? `${this.windReadout()}   ${w.holdingBreath ? `HOLDING BREATH ${'▮'.repeat(Math.ceil(w.breath * 5))}` : '[SHIFT] HOLD BREATH'}` : '',
      scoped: false,
      teamNames: this.match.teamNames,
    }, dt);
    w.spread();
    this.ui.updateFeed(this.match.feed, this.time);
    // low ammo callout once per magazine
    if (s.mag > 0 && s.mag <= Math.ceil(s.def.mag * 0.2) && s.def.mag > 6 && !this.lowCalled) {
      this.lowCalled = true;
      this.playerVoice('lowAmmo', 0.5);
    } else if (s.mag > Math.ceil(s.def.mag * 0.2)) this.lowCalled = false;
  }

  /** Wind as the shooter sees it: speed and an arrow relative to the view direction. */
  private windReadout() {
    const wv = this.weather.wind;
    const rel = Math.atan2(wv.x, -wv.z) + this.player.yaw; // 0 = blowing away from you, + = to the right
    const arrows = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
    const i = ((Math.round(rel / (Math.PI / 4)) % 8) + 8) % 8;
    return `WIND ${this.weather.windSpeed.toFixed(1)} m/s ${arrows[i]}`;
  }

  /** Weapon FOV (hip; ADS eases to the 48° the sights are designed for) and the separate arms FOV. */
  private viewmodelFov(ads: number) {
    const wf = Settings.data.weaponFov ?? 48;
    const vf = wf + (48 - wf) * ads;
    if (Math.abs(this.vmCamera.fov - vf) > 0.01) {
      this.vmCamera.fov = vf;
      this.vmCamera.updateProjectionMatrix();
    }
    const af = (Settings.data.armsFov ?? 48) + (vf - (Settings.data.armsFov ?? 48)) * ads * 0.6;
    RiggedArms.armWarp.value = Math.tan(THREE.MathUtils.degToRad(vf) / 2) / Math.tan(THREE.MathUtils.degToRad(af) / 2);
  }

  private menuCamera(dt: number) {
    this.menuT += dt * 0.025;
    const t = this.menuT;
    const c = new THREE.Vector3(-20 + Math.cos(t) * 110, 0, 10 + Math.sin(t) * 110);
    c.y = Math.max(this.terrain.heightAt(c.x, c.z), 0) + 34 + Math.sin(t * 2.3) * 6;
    this.camera.position.copy(c);
    this.camera.lookAt(-30, 6, 0);
    this.camera.fov = 52;
    this.camera.updateProjectionMatrix();
  }

  private deathCam(dt: number) {
    const cam = this.camera;
    const p = this.player.pos;
    const target = this.deathCamTarget ?? p.clone().add(new THREE.Vector3(1, 0, 0));
    const want = new THREE.Vector3(p.x, p.y + 0.45, p.z);
    cam.position.lerp(want, 1 - Math.exp(-3 * dt));
    const m = new THREE.Matrix4().lookAt(cam.position, target.clone().setY(target.y + 1.2), new THREE.Vector3(0, 1, 0));
    const q = new THREE.Quaternion().setFromRotationMatrix(m).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.3));
    cam.quaternion.slerp(q, 1 - Math.exp(-2.5 * dt));
    cam.updateMatrixWorld();
  }

  private shadowFrame = 0;
  private shadowT = 0;
  renderFrame(dt: number) {
    Bot.nightView.night = this.env.night > 0.5;
    Bot.nightView.nvg = !!this.nvg?.active;
    // world matrices once per frame (three otherwise walks the whole scene graph again inside
    // every render() call: scope, AO beauty + its two transparency passes, water reflection)
    this.scene.updateMatrixWorld();
    // soldiers: detail level and shadows by distance; past 150 m a billboard instead of the mesh
    const cp = this.camera.position;
    const imp = this.impostors;
    imp?.begin();
    const scoped = !!(this.weapons?.cur.def.scope && this.weapons.ads > 0.5);
    for (const b of this.bots) {
      if (!b.root.visible) continue;
      const d = b.position().distanceTo(cp);
      // (not through a magnifying scope: there a far soldier is big on screen)
      const far = imp && d > 150 && !scoped && b.alive && !this.killcam && imp.add(b.position(), cp, b.yaw, b.team, b.moveSpeed > 1, b.soldier.anim.phase);
      b.soldier.model.visible = !far;
      if (!far) b.visualLod(d);
    }
    imp?.end(1 - this.env.night * 0.85);
    this.terrain.updateLod(cp);
    // sun shadows refresh at a fixed rate per preset (the light matrices only change together
    // with the map, so between refreshes the last map stays exact for everything static; only
    // moving soldiers' shadows step). Never "more often when slow": that is when it hurts most.
    this.shadowFrame++;
    this.shadowT -= dt;
    if (this.shadowT <= 0) {
      const q = Settings.data.quality;
      this.shadowT = q === 'low' ? 1 / 12 : q === 'medium' ? 1 / 20 : q === 'high' ? 1 / 30 : 0;
      this.renderer.shadowMap.needsUpdate = true;
    }
    const w = this.weapons;
    const def = w.cur.def;
    const playing = this.state === 'playing';
    // picture-in-picture scope
    if (w.cur.model !== this.scopeModel) {
      this.scopeModel = w.cur.model;
      this.scope.attach(w.cur.model.scopeLens);
    }
    // the scope picture is a second full scene render: every frame only while aiming, a cheap
    // refresh every 4th frame at the hip (the lens is a few pixels then)
    if (def.scope && w.cur.model.scopeLens && playing && (w.ads > 0.02 || this.frameNo % 4 === 0)) {
      const lens = w.cur.model.scopeLens;
      const lp = new THREE.Vector3();
      lens.getWorldPosition(lp);
      const lensR = (lens.geometry as THREE.CircleGeometry).parameters?.radius ?? 0.0185;
      const ang = 2 * Math.atan(lensR / Math.max(0.05, lp.length()));
      this.scope.mat.uniforms.uReticle.value = def.scope.reticle === 'cross' ? 1 : 0;
      const ndc = lp.clone().project(this.vmCamera);
      const edge = lp.clone().add(new THREE.Vector3(lensR, 0, 0)).project(this.vmCamera);
      const W = window.innerWidth, H = window.innerHeight;
      this.scopeScreen = { cx: (ndc.x * 0.5 + 0.5) * W, cy: (-ndc.y * 0.5 + 0.5) * H, r: Math.abs(edge.x - ndc.x) * 0.5 * W };
      this.scope.render(this.renderer, this.scene, this.camera, ang * (this.camera.fov / this.vmCamera.fov), def.scope.zoom, w.ads, new THREE.Vector2(ndc.x, ndc.y));
    }
    this.pipeline.render(dt, {
      dof: playing && !this.killcam ? w.ads * (def.cls === 'Sniper' ? 1.0 : def.cls === 'Marksman' ? 0.8 : 0.5) : 0,
      dofFocus: 25,
      damage: playing && !this.killcam ? this.damageFx : 0,
      flash: this.killcam ? 0 : this.flashFx,
      suppression: this.killcam ? 0 : this.suppression,
      underwater: this.camera.position.y < -0.1 ? 1 : 0,
      exposure: this.env.exposure,
      rays: this.env.rays,
      sunDir: this.env.sunDir,
      sunColor: this.env.sunColor,
    });
  }

  // ================================================================ killcam
  private recordFrame() {
    const n = this.bots.length;
    this.recorder.record(this.time, (a) => {
      for (let i = 0; i < n; i++) writeBot(this.bots[i], a, i * SNAP);
      this.playerPose(a, n * SNAP);
    });
  }

  /**
   * The local player's full pose state (same layout as Bot.replayState): what killcam replays,
   * multiplayer peers and your own first-person legs animate from.
   */
  playerPose(a: { [i: number]: number }, o = 0) {
    const pl = this.player;
    const p = pl.pos;
    a[o] = p.x; a[o + 1] = p.y; a[o + 2] = p.z;
    a[o + 3] = pl.yaw; a[o + 4] = pl.yaw; a[o + 5] = pl.pitch;
    a[o + 6] = Math.hypot(pl.vel.x, pl.vel.z);
    a[o + 7] = this.avatar.alive ? 1 : 0;
    a[o + 8] = pl.stance !== 'stand' ? 1 : 0;
    a[o + 9] = this.avatar.alive ? 0 : this.time - this.deathTime;
    a[o + 10] = this.weapons.ads > 0.3 || this.time - this.lastShotT < 2 ? 1 : 0;
    a[o + 11] = pl.stance === 'prone' ? 2 : pl.stance === 'crouch' ? 1 : 0;
    a[o + 12] = (pl.sprinting ? 1 : 0) | (pl.tactical ? 2 : 0) | (pl.sliding ? 4 : 0) | (pl.diving ? 8 : 0) | (pl.ladder ? 16 : 0) | (pl.mantle ? 32 : 0) | (!pl.grounded ? 64 : 0) | (this.nvg?.active ? 128 : 0);
    a[o + 13] = clamp(this.peekLean / 0.4, -1, 1);
    const act = this.vm.action;
    let code = 0;
    if (act) {
      const ty = act.type;
      code = ty.startsWith('reload') || ty === 'breakReload' || ty === 'karReload' || ty.startsWith('shell') ? 1
        : ty.startsWith('lethal') || ty === 'throw' || ty === 'tactical' || ty.endsWith('Throw') ? 2
        : ty === 'melee' ? 3 : ty.startsWith('knife') ? 4 : ty === 'draw' || ty === 'holster' ? 5 : ty === 'bolt' || ty === 'karCycle' || ty === 'pump' ? 6 : ty === 'claymore' || ty === 'trophy' ? 7 : 0;
    }
    a[o + 14] = code;
    a[o + 15] = act ? act.t : 0;
    a[o + 16] = pl.vel.x; a[o + 17] = pl.vel.z; a[o + 18] = pl.vel.y; a[o + 19] = 0;
  }

  /** third-person animation events: magazines dropped by soldiers reloading near you */
  private magProtos = new Map<string, THREE.Object3D | null>();
  private botAnimEvent(b: Bot, ev: string, p: THREE.Vector3) {
    if (ev !== 'magOut' || p.distanceTo(this.camera.position) > 30 || b.def.id === 'db12' || b.def.cls === 'Shotgun') return;
    const id = b.def.id;
    if (!this.magProtos.has(id)) this.magProtos.set(id, WEAPON_BUILDERS[id as WeaponId](this.wmats).parts.mag ?? null);
    const proto = this.magProtos.get(id);
    if (!proto) return;
    const q = b.weapon.root.getWorldQuaternion(new THREE.Quaternion());
    this.fx.debris(proto, p, q, new THREE.Vector3(b.velocity.x * 0.5, -0.5, b.velocity.z * 0.5), new THREE.Vector3(Math.random() * 4 - 2, 0, Math.random() * 3), 'mag');
  }

  private startKillcam() {
    const slot = this.killcamSlot;
    this.killcamSlot = -1;
    const killer = this.bots[slot];
    if (!killer) return false;
    const w = this.recorder.window(this.deathTime - 3.8, this.deathTime + 0.6);
    if (w.frames.length < 30) return false;
    const saved = this.bots.map((b) => b.saveVisual());
    this.killcam = { ...w, killer: slot, t: w.frames[0].t, t0: w.frames[0].t, t1: w.frames[w.frames.length - 1].t, fired: new Set(), saved };
    // the killer's gun in the viewmodel
    const def = killer.def;
    this.vm.setWeapon(WEAPON_BUILDERS[def.id as WeaponId](this.wmats), def);
    this.vm.cancelAction();
    this.ui.showDeath(false);
    this.ui.showHUD(false);
    this.ui.showKillcam(true, killer.name.toUpperCase(), def.name.toUpperCase());
    this.audio.play('radio', { gain: 0.4, bus: 'ui', reverb: 0, rate: 0.8 });
    return true;
  }

  private killcamBuf = new Float32Array(SNAP);
  private updateKillcam(dt: number) {
    const kc = this.killcam!;
    // slow motion around the killing shot
    const slow = kc.t > this.deathTime - 0.45 && kc.t < this.deathTime + 0.25;
    const step = dt * (slow ? 0.35 : 1);
    kc.t += step;
    const n = this.bots.length;
    const s = this.killcamBuf;
    for (let i = 0; i < n; i++) this.bots[i].puppet(sample(kc, i, kc.t, s), step);
    this.ghost.puppet(sample(kc, n, kc.t, s), step);
    this.ghost.root.visible = this.ghost.root.visible && true;
    // camera = the killer's eyes
    const ks = sample(kc, kc.killer, kc.t, s);
    const killer = this.bots[kc.killer];
    killer.root.visible = false;
    const eyeH = ks[8] > 0.5 ? 1.05 : 1.58;
    const cam = this.camera;
    cam.position.set(ks[0], ks[1] + eyeH, ks[2]);
    cam.rotation.set(ks[5], ks[4], 0, 'YXZ');
    const sniperAds = !!killer.def.scope && ks[10] > 0.5;
    const fov = sniperAds ? 14 : ks[10] > 0.5 ? 52 : 64;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    // recorded shots
    kc.shots.forEach((sh, i) => {
      if (kc.fired.has(i) || sh.t > kc.t) return;
      kc.fired.add(i);
      const hit = this.physics.raycast(sh.origin, sh.dir, 300);
      const end = hit ? hit.point : sh.origin.clone().addScaledVector(sh.dir, 300);
      this.fx.tracer(sh.id === kc.killer ? cam.position.clone().addScaledVector(sh.dir, 0.8).add(new THREE.Vector3(0, -0.12, 0)) : sh.muzzle, end, 500);
      if (hit) this.fx.impact(hit.point, hit.normal, hit.info.surface, sh.dir, false);
      this.fx.muzzleWorld(sh.muzzle, sh.dir, false, 0.8);
      const key = `shot_${sh.def}`;
      if (sh.id === kc.killer) {
        this.audio.play(key, { gain: 0.9, reverb: 0.4, vary: 0.03, rate: slow ? 0.8 : 1 });
        this.vm.kick(killer.def, ks[10]);
      } else this.audio.play(key, { pos: sh.muzzle, gain: 0.9, ref: 10, reverb: 0.5, delay: true });
    });
    // viewmodel of the killer (hidden behind a scope)
    this.vm.root.visible = !sniperAds;
    this.vm.update(dt, { ads: ks[10] > 0.5 && killer.def.cls !== 'Shotgun' ? 0.72 : 0, sprint: ks[6] > 5 ? 1 : 0, tactical: 0, slide: 0, crouch: ks[8], air: 0, speed01: Math.min(1, ks[6] / 6), stepPhase: (kc.t * 1.6) % 1, foot: 0, lookDX: 0, lookDY: 0, strafe: 0, vy: 0, indoor: this.indoor, firing: false } as any);
    this.ui.setKillcamProgress((kc.t - kc.t0) / (kc.t1 - kc.t0));
    this.env.update(dt, cam);
    this.fx.update(step);
    this.world.update(this.time, cam.position, this.env);
    this.weather.update(dt, cam.position, this.env.weather, window.innerHeight);
    this.audio.setListener(cam);
    const skip = this.input.wasPressed('fire') || this.input.wasPressed('jump');
    if (kc.t >= kc.t1 || skip) this.endKillcam();
  }

  private endKillcam() {
    const kc = this.killcam!;
    this.bots.forEach((b, i) => b.restoreVisual(kc.saved[i] as ReturnType<Bot['saveVisual']>));
    this.ghost.root.visible = false;
    this.killcam = null;
    this.ui.showKillcam(false);
    this.ui.showHUD(true);
    if (this.match.phase === 'live') this.respawnPlayer();
  }

  // ================================================================ loadout
  private applyLoadout() {
    const u = this.ui;
    this.loadout = { primary: u.primary, secondary: u.secondary, tactical: u.tactical, lethal: u.lethal };
    this.weapons.setLoadout([u.primary, u.secondary]);
    this.tacCount = TACTICAL_COUNT[u.tactical];
    this.frags = LETHAL_COUNT[u.lethal] ?? 2;
  }

  /** Loadout confirmed in a menu: in the menu it is simply stored; in a match it applies right away
   *  if you only just spawned (and haven't fired), otherwise on your next spawn. */
  private onLoadoutChanged() {
    if (this.state !== 'paused' && this.state !== 'playing') return;
    const fresh = this.avatar.alive && this.time - this.spawnTime < 12 && !this.firedSinceSpawn;
    if (fresh) {
      this.applyLoadout();
      this.ui.notify('LOADOUT UPDATED', '');
    } else this.ui.notify('LOADOUT SAVED', 'APPLIES ON NEXT SPAWN');
  }

  // ================================================================ doors
  private movers: Mover[] = [];
  /**
   * Compile every shader the match can ever need, up front. renderer.compile only sees visible
   * objects, so pooled things (casings, debris, decals, held items, goggles) and things that only
   * appear later used to compile mid-fight — most visibly the magazine an *empty* reload drops
   * into the world: its materials under world lighting + fog + shadows were brand-new programs,
   * a freeze of up to a few seconds on Windows / ANGLE (or a lost GPU context) the first time.
   */
  private async warmShaders(progress: (k: number) => void = () => {}) {
    // everything visible and nothing frustum-culled for the warm-up: every program compiles AND
    // every vertex buffer / texture is uploaded now, not the first time you turn to face something
    const show = (root: THREE.Object3D) => {
      const hidden: THREE.Object3D[] = [];
      root.traverse((o) => {
        if (!o.visible) {
          hidden.push(o);
          o.visible = true;
        }
      });
      return () => hidden.forEach((o) => (o.visible = false));
    };
    // upload pass: everything drawn once with frustum culling off into a 1×1 target (no shadows,
    // no water reflection) — every vertex buffer and texture goes to the GPU now instead of the
    // first time you turn to face something, at almost no pixel cost
    const uploadAll = (root: THREE.Scene, cam: THREE.Camera) => {
      const culled: THREE.Object3D[] = [];
      root.traverse((o) => {
        if (o.frustumCulled) {
          culled.push(o);
          o.frustumCulled = false;
        }
      });
      const water = this.env.water as THREE.Object3D;
      const wob = water.onBeforeRender;
      water.onBeforeRender = () => {};
      const sm = this.renderer.shadowMap.needsUpdate;
      this.renderer.shadowMap.needsUpdate = false;
      const prev = this.renderer.getRenderTarget();
      const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
      try {
        this.renderer.setRenderTarget(rt);
        this.renderer.render(root, cam);
      } finally {
        this.renderer.setRenderTarget(prev);
        rt.dispose();
        water.onBeforeRender = wob;
        this.renderer.shadowMap.needsUpdate = sm;
        culled.forEach((o) => (o.frustumCulled = true));
      }
    };
    const warm = new THREE.Group();
    warm.position.set(0, -300, 0);
    const vmWarm = new THREE.Group();
    vmWarm.position.set(0, 0, -50);
    for (const id of Object.keys(WEAPON_BUILDERS) as WeaponId[]) {
      warm.add(WEAPON_BUILDERS[id](this.wmats).root); // dropped mags / loaders / bot guns
      vmWarm.add(WEAPON_BUILDERS[id](this.wmats).root); // every gun in first person
    }
    warm.add(Pickups.model(), Killstreaks.heliModel(), ...Bot.gearWarmMeshes());
    // one of every effect, far under the map (lazily created decal / particle materials)
    {
      const P = new THREE.Vector3(0, -300, 0), up = new THREE.Vector3(0, 1, 0), fwd = new THREE.Vector3(0, 0, -1);
      for (const sf of ['concrete', 'metal', 'wood', 'glass', 'flesh', 'water', 'dirt', 'grass', 'snow', 'rock', 'fabric', 'woodFloor', 'asphalt', 'gravel', 'sand'] as const) {
        this.fx.impact(P, up, sf, fwd, true);
        this.fx.decal(P, up, sf, 0.1);
      }
      this.fx.explosion(P, up, 1, 'dirt');
      this.fx.explosion(P, up, 1, 'snow');
      this.fx.muzzleWorld(P, fwd, false, 1);
      this.fx.muzzleWorld(P, fwd, true, 1);
      this.fx.tracer(P, P.clone().add(fwd), 600);
      this.fx.flashPop(P);
      this.fx.smokePuff(P, up, [0.7, 0.7, 0.7], 1, 1);
      this.fx.killBurst(P, fwd, true, P.y - 1);
      for (const k of ['rifle', 'pistol', 'big', 'shotgun'] as const) this.fx.shell(P, up, k);
    }
    for (const k of ['frag', 'flash', 'stun', 'smoke'] as const) warm.add(Viewmodel.makeGrenade(k));
    this.scene.add(warm);
    this.vmScene.add(vmWarm);
    const restoreW = show(this.scene);
    const restoreV = show(this.vmScene);
    // compile for the state the game really renders in: into the composer's linear half-float
    // targets. (Compiling with the canvas bound produced sRGB-output variants that were never
    // used — every program compiled a second time on the first visible frame, a multi-second
    // freeze right after the loading screen.) Compiled in parallel on driver threads where possible.
    const prevRT = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.pipeline.composer.readBuffer);
    try {
      await compileWithProgress(this.renderer, this.scene, this.camera, (k) => progress(k * 0.6));
      await compileWithProgress(this.renderer, this.vmScene, this.vmCamera, (k) => progress(0.6 + k * 0.15));
    } finally {
      this.renderer.setRenderTarget(prevRT);
    }
    // one real frame through the whole pipeline with everything visible (shadow depth programs,
    // the water's mirror pass, AO, bloom, grade, SMAA, the scope), drawn behind the loading screen
    try {
      const vmVis = this.vm.root.visible;
      this.vm.root.visible = true;
      this.renderer.shadowMap.needsUpdate = true;
      this.scene.updateMatrixWorld();
      this.pipeline.render(1 / 60, { dof: 0.5, dofFocus: 25, damage: 0.1, flash: 0, suppression: 0.1, underwater: 0, exposure: 1, rays: 0.5, sunDir: this.env.sunDir, sunColor: this.env.sunColor });
      // (skipped by the automated tests: a software GPU spends seconds on it, a real one milliseconds)
      if (!this.testMode || location.search.includes('warmupload')) {
        uploadAll(this.scene, this.camera);
        uploadAll(this.vmScene, this.vmCamera);
      }
      this.vm.root.visible = vmVis;
    } finally {
      restoreW();
      restoreV();
      this.scene.remove(warm);
      this.vmScene.remove(vmWarm);
    }
    progress(1);
  }

  // ---------------------------------------------------------------- night vision
  nvg!: NightVision;
  private cantZoom = 0;
  private nightNagT = 0;
  perf!: PerfOverlay;
  /** background sound loading (resolves when every recording is decoded) */
  audioLoad: Promise<unknown> = Promise.resolve();
  gpuTimer!: GpuTimer;
  impostors: Impostors | null = null;
  governor!: PerfGovernor;
  hw!: HardwareInfo;
  private nvgFrame(dt: number) {
    const w = this.weapons;
    // night prompt + an occasional HQ reminder while you play without goggles
    const dark = this.env.night > 0.5 && this.state === 'playing' && this.avatar.alive && !this.killcam;
    const needGoggles = dark && !this.nvg.active && this.vm.action?.type !== 'nvg';
    this.ui.nvgPrompt(needGoggles);
    this.nightNagT = needGoggles ? this.nightNagT + dt : 0;
    if (this.nightNagT > 25) {
      this.nightNagT = -60;
      this.radio.say('ann', 'nodsReminder', this.time, { cooldown: 90, ttl: 8 });
    }
    if (!this.avatar.alive && this.nvg.active) this.nvg.reset();
    let laser: { from: THREE.Vector3; dir: THREE.Vector3 } | null = null;
    const sock = w.cur?.model.sockets.laser;
    if (sock && this.avatar.alive && this.vm.root.visible && !this.killcam && this.nvg.vis > 0) {
      const lp = this.vm.socketCameraSpace('laser');
      const from = this.screenToWorld(lp.clone().project(this.vmCamera), lp.length());
      // hip: straight down the laser's axis; aimed: zeroed on the point under the crosshair
      const q = sock.getWorldQuaternion(new THREE.Quaternion());
      const rootQ = this.vm.root.getWorldQuaternion(new THREE.Quaternion()).invert();
      const hipDir = new THREE.Vector3(0, 0, -1).applyQuaternion(rootQ.multiply(q)).applyQuaternion(this.camera.quaternion).normalize();
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const hit = this.physics.raycast(this.camera.position, fwd, 220);
      const aimP = hit ? hit.point : this.camera.position.clone().addScaledVector(fwd, 220);
      const aimDir = aimP.sub(from).normalize();
      laser = { from, dir: hipDir.lerp(aimDir, clamp(w.ads * (0.35 + 0.65 * w.cant), 0, 1)).normalize() };
    }
    this.nvg.update(dt, this.env, this.camera, laser);
    const u = this.pipeline.grade.mat.uniforms;
    u.uTint.value.copy(this.env.gradeTint);
    u.uSatBoost.value = this.env.gradeSat;
    u.uNVG.value = this.nvg.vis;
    u.uNVGPower.value = this.nvg.power;
    u.uNVGGain.value = this.nvg.gain;
    u.uNVGFlash.value = this.nvg.flash;
    u.uNVGIllum.value = this.nvg.illum;
    u.tDepth.value = Settings.data.ao ? this.pipeline.ao.beautyRenderTarget.depthTexture : null;
    u.uHasDepth.value = u.tDepth.value ? 1 : 0;
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    this.pipeline.bloom.strength = 0.35 + 0.45 * this.nvg.vis * Math.min(1.2, this.nvg.power);
  }

  // ---------------------------------------------------------------- doors: use (E) and peek (ADS)
  private doorFocusF = -1;
  private doorFocusD: Door | null = null;
  /** The door you are looking at, within arm's reach. */
  private doorFocus(): Door | null {
    if (this.doorFocusF === this.frameNo) return this.doorFocusD;
    this.doorFocusF = this.frameNo;
    const eye = this.camera.position;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    let best: Door | null = null, bs = 0;
    for (const d of this.doors.doors) {
      // aim at the leaf's centre where it is now (closed: the doorway; open: against the wall)
      const c = new THREE.Vector3(d.spec.width / 2, 1, 0).applyMatrix4(d.pivot.matrixWorld);
      const to = c.sub(eye);
      const dist = to.length();
      if (dist > 2.4) continue;
      const dot = to.divideScalar(dist).dot(fwd);
      if (dot < 0.72) continue;
      const blocked = this.physics.raycast(eye, to, Math.max(0, dist - 0.35));
      if (blocked && (blocked.info as any).tag !== 'door') continue;
      const score = dot - dist * 0.1;
      if (score > bs) {
        bs = score;
        best = d;
      }
    }
    this.doorFocusD = best;
    return best;
  }

  private useDoor(d: Door) {
    const closing = Math.abs(d.target) > 0.5;
    this.doors.toggle(d, this.player.pos);
    if (closing) {
      this.audio.play('doorOpen', { pos: d.centre, gain: 0.55, rate: 0.85, ref: 5, reverb: 0.25, vary: 0.05 });
      window.setTimeout(() => this.audio.play('click', { pos: d.centre, gain: 0.7, rate: 0.6, ref: 4, reverb: 0.2 }), 650);
    }
    this.vm.landImpulse(1.2);
  }

  private peekLean = 0;
  private peekDoor: Door | null = null;
  private peekAng = 0;
  private peekCreak = false;
  /**
   * MW-style door peek: aim down sights close to a closed door and you ease it open a crack with
   * the muzzle, leaning out to the side where the gap opens; the gun tucks in tight and cants
   * with the lean. Let go and the door stays cracked; walk on and it swings open.
   */
  private updateDoorPeek(dt: number) {
    const w = this.weapons, p = this.player;
    let target = 0;
    const can = this.avatar.alive && this.state === 'playing' && w.adsWanted && !p.sprinting && !p.sliding && p.grounded && (!this.vm.action || this.vm.action.type === 'inspect');
    const d = can ? this.peekCandidate() : null;
    if (d) {
      if (d !== this.peekDoor) {
        this.peekDoor = d;
        this.peekAng = Math.abs(d.angle);
        this.peekCreak = false;
      }
      // pushing in opens it further, standing still it creeps to a narrow gap
      const toward = -Math.sign(this.doors.side(d, p.pos)) || 1;
      const push = clamp(p.vel.dot(d.normal) * toward, 0, 2);
      this.peekAng = Math.min(0.42 + push * 0.2, this.peekAng + dt * (0.3 + push * 0.4));
      this.doors.crack(d, p.pos, this.peekAng);
      if (!this.peekCreak && this.peekAng > 0.08) {
        this.peekCreak = true;
        this.audio.play('doorOpen', { pos: d.centre, gain: 0.22, rate: 0.62, ref: 4, reverb: 0.3 });
      }
      // lean toward the latch edge, where the gap opens
      const latch = d.spec.hinge.clone().addScaledVector(d.spec.along, d.spec.width);
      const right = new THREE.Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
      const side = Math.sign(latch.sub(p.pos).dot(right)) || 1;
      target = side * 0.16;
      const wall = this.physics.raycast(this.camera.position, right.multiplyScalar(side), 0.4);
      if (wall) target = side * Math.max(0, wall.distance - 0.2);
    } else {
      this.peekDoor = null;
    }
    // ---- Q/E lean: hold to peek round a corner. The head swings out from the hips (sideways and a
    // touch down), the view rolls into the lean and the gun stays on the sights. Two sideways rays
    // (eye and shoulder height) keep the head out of walls, so you can lean flat against cover.
    const inp = this.input;
    const lk = d ? 0 : (inp.isDown('leanR') ? 1 : 0) - (inp.isDown('leanL') ? 1 : 0);
    const canLean = this.avatar.alive && this.state === 'playing' && !p.sprinting && !p.sliding && !p.ladder && !p.mantle && !this.world.zips.ride && !this.tmap?.open;
    let leanT = 0;
    if (lk && canLean) {
      const reach = p.stance === 'prone' ? 0.24 : p.stance === 'crouch' ? 0.34 : 0.4;
      const right = this.tmpLeanR.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw)).multiplyScalar(lk);
      const eye = p.eyePosition(this.tmpLeanE);
      let room = reach;
      for (const dy of [0, -0.32]) {
        eye.y += dy;
        const hit = this.physics.raycast(eye, right, reach + 0.22);
        if (hit) room = Math.min(room, Math.max(0, hit.distance - 0.2));
      }
      leanT = lk * room;
      target = leanT;
    }
    if (Math.sign(leanT) !== Math.sign(this.leanKeyed) && leanT !== 0) {
      // the weight shift: a short cloth rustle and gear shuffle as the body swings out
      this.audio.play('cloth', { gain: 0.32, rate: 0.9 + Math.random() * 0.2 });
      this.vm.leanKick(Math.sign(leanT));
    }
    this.leanKeyed = leanT;
    this.peekLean = damp(this.peekLean, target, d ? 6.5 : 9, dt);
    this.leanRollMul = damp(this.leanRollMul, d ? 0.55 : 0.42, 6, dt);
    w.peek = d ? clamp(this.peekLean / 0.16, -1, 1) : 0;
    w.lean = d ? 0 : clamp(this.peekLean / 0.4, -1, 1);
    this.rig.peekLean = this.peekLean;
    this.avatar.lean.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw)).multiplyScalar(this.peekLean);
  }
  /**
   * LMG bipod: comes down by itself when you go prone (on the ground in front of you) or when you
   * aim standing / crouched still with a waist-to-chest high ledge right in front (a wall, sill,
   * car bonnet). Moving off, standing up or lowering the sights folds it again.
   */
  private bipodOn = false;
  private updateBipod(dt: number) {
    void dt;
    const w = this.weapons, p = this.player;
    const lmg = w.cur?.def.id === 'lmg' && this.avatar.alive && this.state === 'playing';
    let want = false;
    let mounted = false;
    if (lmg && !w.reloading && !w.switching && !p.sprinting && !p.sliding && !p.ladder && !p.mantle && p.grounded && p.horizSpeed() < (this.bipodOn ? 0.9 : 0.4)) {
      if (p.stance === 'prone') want = true;
      else if (w.adsWanted) {
        // a surface to rest on: something in front a little below the eyes, open air at eye level
        const fwd = new THREE.Vector3(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
        const eye = p.eyePosition(new THREE.Vector3());
        const low = this.physics.raycast(eye.clone().setY(eye.y - 0.32), fwd, 0.85);
        const high = this.physics.raycast(eye.clone().setY(eye.y - 0.05), fwd, 0.95);
        if (low && !high && Math.abs(low.normal.y) < 0.6) {
          // find the top of it under the muzzle
          const top = this.physics.raycast(eye.clone().addScaledVector(fwd, Math.min(0.9, low.distance + 0.12)).setY(eye.y), new THREE.Vector3(0, -1, 0), 0.6);
          if (top && top.normal.y > 0.6) {
            want = true;
            mounted = true;
          }
        }
      }
    }
    if (want !== this.bipodOn) {
      this.bipodOn = want;
      this.audio.play('bipod', { gain: want ? 0.75 : 0.5, rate: want ? 1 : 1.15, reverb: 0.04 });
      if (want) this.vm.landImpulse(0.6);
    }
    w.bipod = damp(w.bipod, want ? 1 : 0, want ? 6 : 10, dt);
    void mounted;
  }
  private leanKeyed = 0;
  private leanRollMul = 0.55;
  private tmpLeanR = new THREE.Vector3();
  private tmpLeanE = new THREE.Vector3();

  private peekCandidate(): Door | null {
    const p = this.player.pos;
    const fwd = new THREE.Vector3(-Math.sin(this.player.yaw), 0, -Math.cos(this.player.yaw));
    let best: Door | null = null, bd = 1e9;
    for (const d of this.doors.doors) {
      if (Math.abs(d.target) > 0.75) continue;
      if (Math.abs(p.y + 1 - d.centre.y) > 1) continue;
      const side = this.doors.side(d, p);
      if (Math.abs(side) < 0.3 || Math.abs(side) > 1.7) continue;
      const along = new THREE.Vector3().subVectors(p, d.centre).dot(d.spec.along);
      if (Math.abs(along) > d.spec.width / 2 + 0.55) continue;
      // looking at it
      const face = d.normal.clone().multiplyScalar(-Math.sign(side));
      if (fwd.dot(face) < 0.55) continue;
      const dist = Math.abs(side) + Math.abs(along) * 0.5;
      if (dist < bd) {
        bd = dist;
        best = d;
      }
    }
    return best;
  }

  /** A window in front of the player to dive through: checks the sill height, the gap and the far side, then breaks it. */
  private windowVault(feet: THREE.Vector3, fwd: THREE.Vector3) {
    const down = new THREE.Vector3(0, -1, 0);
    let best: { over: THREE.Vector3; land: THREE.Vector3; sill: number } | null = null, bd = 1e9;
    for (const w of this.world.buildings.windows) {
      if (w.h < 0.85 || w.w < 0.55) continue; // too small to get through
      const rel = feet.clone().sub(w.c);
      const side = rel.x * w.n.x + rel.z * w.n.z;
      if (Math.abs(side) > 1.05 || Math.abs(side) < 0.05) continue;
      const toward = -Math.sign(side);
      const dir = new THREE.Vector3(w.n.x * toward, 0, w.n.z * toward).normalize();
      if (fwd.x * dir.x + fwd.z * dir.z < 0.55) continue;
      const along = new THREE.Vector3(-w.n.z, 0, w.n.x).normalize();
      const lateral = rel.dot(along);
      if (Math.abs(lateral) > w.w / 2 - 0.12) continue;
      const sill = w.c.y - w.h / 2;
      const hgt = sill - feet.y;
      if (hgt < 0.25 || hgt > 1.55) continue;
      const over = w.c.clone().addScaledVector(along, lateral).setY(sill + 0.14);
      // room on the far side: nothing right behind the window, and ground to land on
      const start = over.clone().addScaledVector(dir, 0.18).setY(sill + 0.45);
      if (this.physics.raycast(start, dir, 0.75)) continue;
      const beyond = over.clone().addScaledVector(dir, 1.0);
      const g = this.physics.raycast(beyond.clone().setY(sill + 1.0), down, 6);
      if (!g || g.point.y > sill + 0.25) continue;
      const d = Math.abs(side) + Math.abs(lateral) * 0.5;
      if (d < bd) {
        bd = d;
        best = { over, land: new THREE.Vector3(beyond.x, g.point.y, beyond.z), sill };
        (best as any).w = w;
        (best as any).dir = dir;
      }
    }
    if (best) {
      const w = (best as any).w as (typeof this.world.buildings.windows)[number];
      if (!w.broken) {
        w.broken = true;
        this.world.buildings.glass.breakFrame(w.bars, w.pane, best.over, (best as any).dir);
        this.rig.addTrauma(0.18);
      }
    }
    return best;
  }

  private updateDoors(dt: number) {
    const m = this.movers;
    m.length = 0;
    if (this.avatar.alive) m.push({ pos: this.player.pos, vel: this.player.vel, sprint: this.player.sprinting || this.player.tactical || this.player.sliding, id: 0 });
    for (const b of this.bots) if (b.alive) m.push({ pos: b.position(), vel: b.velocity, sprint: false, id: b.id, reach: 1.9 });
    this.doors.update(dt, m);
  }

  private onDoorOpen(d: Door, kicked: boolean, by: Mover) {
    const p = d.centre;
    if (kicked) {
      // the breach: a real kick-in recording (boot impact, splintering frame) over the designed thump
      const mine = by.id === 0;
      if (this.audio.has('doorBreach')) this.audio.play('doorBreach', { pos: p, gain: mine ? 1.25 : 1.05, ref: 7, reverb: 0.35, vary: 0.04, prio: 3 });
      this.audio.play('doorKick', { pos: p, gain: 0.55, ref: 6, reverb: 0.3, vary: 0.05, prio: 2 });
      if (mine) {
        this.playerVoice('breach', 0.7);
        // a short, sharp shake + a kick of the view and the gun
        this.rig.addTrauma(0.3);
        this.rig.killPunch(0.45);
        this.rig.onRecoil(-0.012, (Math.random() - 0.5) * 0.01, (Math.random() - 0.5) * 0.02);
        this.vm.landImpulse(7);
      }
      // whoever stands right behind the door eats it
      const away = by.pos.clone().sub(p).setY(0).normalize().negate();
      for (const c of this.match.players) {
        if (!c.alive || c.id === by.id) continue;
        const to = c.position().clone().sub(p).setY(0);
        if (to.length() < 1.7 && to.dot(away) > 0.1) {
          const kicker = by.id === 0 ? this.avatar : this.bots.find((b) => b.id === by.id);
          if (!kicker || kicker.team === c.team) continue;
          c.health = Math.max(1, c.health - 25);
          c.onDamaged(kicker, 25, away);
          if (kicker === this.avatar) {
            this.ui.hitmarker(false, false, 25);
            this.audio.play('hit', { gain: 0.6, bus: 'ui', reverb: 0 });
          }
        }
      }
      this.alertBots(p, 35, -1);
    } else this.audio.play('doorOpen', { pos: p, gain: 0.8, ref: 3, reverb: 0.2, vary: 0.08 });
  }

  // ================================================================ grenades, melee, killstreaks
  private setupExplosives() {
    this.explosives = new Explosives(this.scene, this.physics, this.fx, {
      damage: (v, att, amt) => {
        if (att === this.avatar && v !== this.avatar && v.health > 0) {
          this.ui.hitmarker(false, false, amt);
          this.audio.play('hit', { gain: 0.6, bus: 'ui', reverb: 0, prio: 3 });
        }
        if (v instanceof Bot && v.alive) v.hear(att.position());
      },
      kill: (att, v, def) => this.onKill(att, v, def.name, false, false),
      blast: (p, n, scale, surface) => {
        this.fx.explosion(p, n, scale, surface);
        this.world.buildings.glass.blast(p, 5.5 * Math.min(1.5, scale));
        const d = p.distanceTo(this.camera.position);
        const occl = d > 6 && !this.physics.lineOfSight(this.camera.position, p.clone().setY(p.y + 0.5));
        this.audio.play(d > 90 ? 'explosionFar' : 'explosion', { pos: p, gain: 1.0 * Math.min(1.2, scale) * (occl ? 0.75 : 1), ref: 14, reverb: 0.7, delay: true, prio: 3, lowpass: occl ? 900 : undefined });
        if (d < 45 && this.avatar.alive) {
          const k = 1 - d / 45;
          this.rig.addTrauma(0.75 * k * k + 0.08);
          this.flashFx = Math.min(0.6, this.flashFx + 0.4 * k * k);
          this.suppression = Math.min(1, this.suppression + 0.8 * k);
          if (d < 14) this.tinnitus = Math.max(this.tinnitus, 1 - d / 14);
        }
        this.noteGunfire(p);
        this.alertBots(p, 70, -1);
      },
      bounce: (p, speed) => this.audio.play('nadeBounce', { pos: p, gain: Math.min(1, 0.25 + speed / 12), ref: 2, reverb: 0.1, vary: 0.1 }),
      flash: (p, owner) => this.flashBang(p, owner),
      stun: (p, owner) => this.stunBlast(p, owner),
      smokeStart: (p) => {
        this.audio.play('smokePop', { pos: p, gain: 0.8, ref: 4, reverb: 0.2 });
        this.audio.play('smokeHiss', { pos: p, gain: 0.7, ref: 4, reverb: 0.3 });
      },
      smokeEmit: (c, dt) => this.emitSmoke(c, dt),
      stick: (g, victim) => {
        this.audio.play('stick', { pos: g.pos, gain: 0.9, ref: 3, reverb: 0.15, vary: 0.08 });
        if (g.kind === 'sticky') this.audio.play('beep', { pos: g.pos, gain: 0.5, ref: 3, rate: 1.1, reverb: 0 });
        if (victim === this.avatar) {
          this.ui.announce('STUCK!', 'GET AWAY FROM YOUR TEAM', 'bad');
          this.audio.play('beep', { gain: 0.7, bus: 'ui', reverb: 0, rate: 1.3 });
        } else if (victim && g.owner === this.avatar) {
          this.ui.killText(0, ['STUCK']);
          this.audio.play('hit', { gain: 0.6, bus: 'ui', reverb: 0 });
        }
        if (victim instanceof Bot && victim.alive) victim.hear(g.owner.position());
      },
      snapshot: (p, owner) => this.snapshotPulse(p, owner),
      decoyStart: (d) => this.audio.play('click', { pos: d.p, gain: 0.5, ref: 2, rate: 1.4 }),
      decoyShot: (d) => this.decoyShot(d),
      intercept: (g) => this.deployables?.intercept(g) ?? false,
    }, () => this.match.players);
    this.explosives.onExplode = (p, radius, owner) => {
      this.deployables.blast(p, radius, owner);
      this.destruction?.blast(p, radius, owner);
    };
    this.deployables = new Deployables(this.scene, this.physics, this.explosives, this.fx, () => this.match.players, {
      sound: (name, p, o = {}) => this.audio.play(name, { pos: p, gain: o.gain ?? 0.8, rate: o.rate, ref: o.ref ?? 4, reverb: 0.2, vary: 0.05 }),
      intercepted: (t, what) => {
        if (t.owner === this.avatar) {
          this.ui.killText(50, [`TROPHY INTERCEPT · ${what.toUpperCase()}`]);
          this.avatar.score += 50;
        }
      },
      destroyed: (kind, owner, by) => {
        if (by === this.avatar && owner !== this.avatar) {
          this.ui.killText(25, [kind === 'trophy' ? 'TROPHY DESTROYED' : 'CLAYMORE DESTROYED']);
          this.audio.play('hit', { gain: 0.6, bus: 'ui', reverb: 0 });
        }
      },
      knives: () => this.tknives.knives,
    });
    this.streaks = new Killstreaks(this.scene, this.physics, this.terrain, this.combat, this.explosives, () => this.match.players, {
      earned: (c, id) => {
        if (c !== this.avatar) return;
        const s = STREAKS.find((x) => x.id === id)!;
        this.ui.announce(`${s.name} READY`, `PRESS [${s.key}]`, 'gold');
        this.audio.play('streak', { gain: 0.5, bus: 'ui', reverb: 0 });
      },
      used: (c, id) => {
        const mine = c.team === this.avatar.team;
        const n = STREAKS.find((x) => x.id === id)!.name;
        if (id !== 'mortar' || mine) this.ui.announce(mine ? `FRIENDLY ${n}${id === 'uav' ? ' ONLINE' : id === 'heli' ? ' INBOUND' : ''}` : `ENEMY ${n}${id === 'uav' ? ' SPOTTED' : ' INBOUND'}`, c === this.avatar ? '' : c.name.toUpperCase(), mine ? 'good' : 'bad');
        if (id === 'uav') this.audio.play('uavPing', { gain: 0.35, bus: 'ui', reverb: 0 });
        // recon / fire support / gunship crews on the net
        // your own call always gets an answer; teammates' / enemies' streaks are called sparingly
        const own = c === this.avatar;
        if (id === 'uav') this.crew('ops', mine ? 'uavUp' : 'uavEnemy', { prio: 2, cooldown: own ? 2 : 30 });
        else if (id === 'mortar') {
          if (mine) this.crew('ops', 'mortarShot', { prio: 2, cooldown: own ? 2 : 25 });
          else this.announcer('mortarEnemy');
        } else {
          this.announcer(mine ? 'heli' : 'heliEnemy');
          if (mine) this.crew('pilot', 'heliIn', { prio: 2, ttl: 10, cooldown: 20 });
        }
        if (c === this.avatar) window.setTimeout(() => this.playerVoice(id), 1300);
      },
      heliShot: (h, o, dir, end) => {
        this.fx.tracer(o, end, 600);
        this.fx.muzzleWorld(o, dir, false, 0.7);
        this.audio.play('shot_k416', { pos: o, gain: 0.9, rate: 0.72, ref: 14, reverb: 0.5, delay: true, vary: 0.04 });
        // near misses on the player
        if (h.team !== this.avatar.team && this.avatar.alive) {
          const cam = this.camera.position;
          const t = cam.clone().sub(o).dot(dir);
          if (t > 0 && o.clone().addScaledVector(dir, t).distanceTo(cam) < 3) {
            this.suppression = Math.min(1, this.suppression + 0.2);
            this.audio.play('whiz', { pos: o.clone().addScaledVector(dir, t), gain: 0.8, ref: 2, reverb: 0 });
          }
        }
      },
      heliEvent: (h, kind) => {
        if (h.team !== this.avatar.team) return;
        const cd = { engage: 16, kill: 9, hit: 12, leave: 0 }[kind];
        this.crew('pilot', kind, { cooldown: cd, ttl: kind === 'leave' ? 8 : 3.5, prio: kind === 'hit' ? 2 : 1 });
      },
      uavEnd: (team) => {
        if (team === this.avatar.team) this.crew('ops', 'uavEnd', { cooldown: 5 });
      },
      mortarDone: (owner) => {
        if (owner === this.avatar) this.crew('ops', 'mortarDone', { ttl: 5 });
      },
      heliDown: (h, by) => {
        const mine = h.team === this.avatar.team;
        if (mine) this.crew('pilot', 'down', { prio: 2, ttl: 4 });
        this.ui.announce(mine ? 'FRIENDLY HELICOPTER DOWN' : 'ENEMY HELICOPTER DOWN', '', mine ? 'bad' : 'good');
        this.announcer(mine ? 'heliLost' : 'heliDown');
        if (by === this.avatar) {
          this.ui.killText(300, ['SHOT DOWN ATTACK HELICOPTER']);
          this.avatar.score += 300;
          this.audio.play('killHead', { gain: 0.9, bus: 'ui', reverb: 0, prio: 3 });
        }
      },
      whistle: (p) => this.audio.play('whistle', { pos: p.clone().setY(p.y + 25), gain: 1, ref: 25, reverb: 0.2 }),
    });
    this.combat.vehicleHit = (o, d, max, shooter) => {
      const hit = this.streaks.hitHeli(o, d, max, shooter.team);
      return hit ? { dist: hit.dist, apply: (dmg) => {
        this.streaks.damageHeli(hit.h, dmg, shooter);
        if (shooter === this.avatar) {
          this.ui.hitmarker(false, false, dmg);
          this.audio.play('imp_metal', { gain: 0.35, bus: 'ui', reverb: 0, rate: 1.3 });
        }
      } } : null;
    };
  }
  private tinnitus = 0;

  /** Where a team's killstreaks should aim: the enemy cluster nearest the action. */
  private enemyFocus(team: 0 | 1) {
    const foes = this.match.players.filter((p) => p.alive && p.team !== team);
    if (!foes.length) return null;
    const hs = this.hotspots.filter((h) => this.time - h.t < 10);
    const ref = hs.length ? hs[hs.length - 1].p : foes[0].position();
    const near = foes.filter((f) => f.position().distanceTo(ref) < 60);
    const set = near.length ? near : foes;
    const c = new THREE.Vector3();
    for (const f of set) c.add(f.position());
    return c.multiplyScalar(1 / set.length);
  }

  /** Grenade (G, hold to cook), melee (V), killstreaks (3 / 4 / 5). */
  private playerActions(dt = 1 / 60) {
    const inp = this.input;
    const w = this.weapons;
    const vm = this.vm;
    const free = !w.switching && !w.reloading && (!vm.action || vm.action.type === 'inspect');
    const lethal = this.loadout.lethal;
    if (inp.wasPressed('grenade') && free && !this.player.mantle) {
      if (lethal === 'c4' && this.frags === 0 && this.myC4().length) this.startDetonate();
      else if (this.frags > 0) {
        this.frags--;
        // lethals: thrown when the key is released (each has its own ready hold)
        const held = { hold: () => inp.isDown('grenade') };
        if (lethal === 'tknife') this.startEquip('tknife', 'lethalKnife', 0.8, [], { holdAt: 0.28, ...held });
        else if (lethal === 'frag') this.startEquip('frag', 'lethalFrag', 1.3, [], { holdAt: 0.52, ...held });
        else if (lethal === 'sticky') this.startEquip('sticky', 'lethalSticky', 1.25, [], { holdAt: 0.52, ...held });
        else if (lethal === 'c4') {
          this.vm.detonatorOut = false;
          this.startEquip('c4', 'lethalC4', 1.45, [], { holdAt: 0.42, ...held }, () => {
            if (this.myC4().length) this.vm.detonatorOut = true;
          });
        }
        else if (lethal === 'claymore') {
          this.player.tactical = false;
          this.startEquip('claymore', 'claymore', 1.95, [[0.03, 'cloth'], [0.12, 'cloth'], [0.21, 'legs'], [0.27, 'legs'], [0.33, 'laserOn'], [0.4, 'plantDip'], [0.58, 'plant'], [0.66, 'cloth']], { holdAt: 0.36, hold: () => inp.isDown('grenade') });
        }
      }
    }
    if (inp.wasPressed('tactical') && this.tacCount > 0 && free && !this.player.mantle) {
      const tk = this.loadout.tactical;
      this.tacCount--;
      if (tk === 'stim') {
        this.player.sprinting = false;
        vm.holdItem('stim');
        vm.play('stim', 1.15, [[0.05, 'cloth'], [0.36, 'stimCap'], [0.56, 'stimInject']]);
      } else {
        // left hand only: the gun stays up (and keeps firing); held ready until the key is released
        this.throwKind = tk;
        this.cookStart = -1;
        this.vm.detonatorOut = false;
        vm.holdItem(tk);
        vm.play('tactical', tk === 'snapshot' ? 1.05 : 1.1, [], undefined, { kind: tk, holdAt: 0.5, hold: () => inp.isDown('tactical') });
      }
    }
    // [H] field upgrade: the trophy system, two-handed deploy
    if (inp.wasPressed('field') && free && !this.player.mantle && !this.player.ladder) {
      if (this.fieldCharge >= 1) {
        this.player.sprinting = false;
        this.player.tactical = false;
        vm.holdItem('trophy');
        vm.play('trophy', 1.65, [[0.03, 'cloth'], [0.16, 'heavyLift'], [0.33, 'legs'], [0.37, 'legs'], [0.4, 'legs'], [0.48, 'cloth'], [0.55, 'shove'], [0.6, 'trophyOut']]);
      } else {
        this.audio.play('click', { gain: 0.3, bus: 'ui', reverb: 0 });
        this.ui.notify('TROPHY SYSTEM', `CHARGING ${Math.floor(this.fieldCharge * 100)}%`);
      }
    }
    if (inp.wasPressed('nvg') && free && !this.player.mantle && !this.player.ladder) {
      // the support hand flips the goggles down (or back up); the image changes when they reach the eyes
      const on = !this.nvg.active;
      this.player.sprinting = false;
      this.player.tactical = false;
      vm.play('nvg', on ? 1.05 : 0.9, on ? [[0.04, 'cloth'], [0.34, 'nvgGrab'], [0.56, 'nvgDown']] : [[0.04, 'cloth'], [0.27, 'nvgUp'], [0.56, 'nvgGrab']], undefined, { on });
    }
    // [V]: tap = quick melee with the gun; keep holding = draw the combat knife. With the knife
    // out, [V] attacks like the fire button.
    if (inp.wasPressed('melee') && free) {
      this.player.sprinting = false;
      if (w.knifeOut) {
        if (!this.knifeAttack('slash')) vm.play('knifeSlash', 0.46, [[0.2, 'swish'], [0.34, 'knifeSwing']], undefined, { side: Math.random() < 0.5 ? 1 : -1 });
      } else {
        vm.play('melee', 0.55, [[0.12, 'swish'], [0.27, 'meleeHit']]);
        this.vHoldT = 0;
      }
    }
    if (this.vHoldT >= 0) {
      if (!inp.isDown('melee')) this.vHoldT = -1;
      else if ((this.vHoldT += dt) > 0.34) {
        this.vHoldT = -1;
        vm.cancelAction();
        w.switching = false;
        w.equipKnife();
        this.audio.play('swish', { gain: 0.35, rate: 1.4, reverb: 0 });
      }
    }
    // ---- killstreaks: UAV from the phone, mortar via the laser designator, helicopter by radio
    const keys: ['streak1' | 'streak2' | 'streak3', StreakId][] = [['streak1', 'uav'], ['streak2', 'mortar'], ['streak3', 'heli']];
    for (const [k, id] of keys) {
      if (!inp.wasPressed(k)) continue;
      if (this.designating) {
        if (id === 'mortar') this.endDesignate(false);
        continue;
      }
      if (!this.streaks.has(this.avatar, id)) {
        this.audio.play('click', { gain: 0.3, bus: 'ui', reverb: 0 });
        continue;
      }
      if (!free) continue;
      if (id === 'uav') {
        vm.holdItem('phone');
        vm.play('uav', 1.4, [[0.05, 'cloth'], [0.53, 'uavPress']]);
      } else if (id === 'mortar') {
        this.designating = true;
        this.player.sprinting = false;
        this.crew('ops', 'mortarCall', { prio: 2, cooldown: 6, ttl: 3 });
        vm.holdItem('laser');
        vm.play('designate', 1.3, [[0.05, 'cloth'], [0.3, 'laserOn']], undefined, { holdAt: 0.5, hold: () => this.designating });
      } else if (!this.streaks.use(this.avatar, id, this.time)) this.ui.notify('UNAVAILABLE', 'HELICOPTER ALREADY IN THE AIR');
    }
    if (this.designating) this.updateDesignator();
    // cooked too long: it goes off in your hand
    if (this.cookStart >= 0 && (vm.action?.type === 'throw' || vm.action?.type === 'lethalFrag') && this.time - this.cookStart >= this.explosives.fuseTime) {
      this.cookStart = -1;
      vm.cancelAction();
      this.explosives.explode(this.player.pos.clone().setY(this.player.pos.y + 1.2), this.avatar, FRAG, 8.5, 200);
    }
  }

  private throwPlayerGrenade() {
    const cooked = this.cookStart >= 0 ? this.time - this.cookStart : 0;
    this.cookStart = -1;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    // thrown from the hand that holds it: lethals right, tacticals left, C4 from the middle
    const kind0 = this.throwKind;
    const side = kind0 === 'frag' || kind0 === 'sticky' || kind0 === 'tknife' ? 0.15 : kind0 === 'c4' ? 0 : -0.15;
    const from = this.camera.position.clone().addScaledVector(fwd, 0.5).addScaledVector(right, side);
    // keep the spawn point out of walls right in front of you
    const blocked = this.physics.raycast(this.camera.position, fwd, 0.6);
    if (blocked) from.copy(this.camera.position).addScaledVector(fwd, Math.max(0.05, blocked.distance - 0.15));
    const kind = this.throwKind;
    if (kind === 'tknife') {
      // a fast, flat throw straight down the crosshair (it drops a little over 20 m)
      const kv = fwd.clone().multiplyScalar(32).add(new THREE.Vector3(0, 0.8, 0)).addScaledVector(this.player.vel, 0.5);
      this.tknives.throw(this.avatar, from, kv);
      return;
    }
    // per item: sticky flies hard and flat, C4 is a short underhand toss, the snapshot rolls low,
    // the decoy is flicked side-arm
    const [spd, up] = ({ c4: [11, 2.2], sticky: [21, 2.8], snapshot: [15, 1.8], decoy: [16, 2.2] } as Record<string, [number, number]>)[kind] ?? [19, 3.2];
    const v = fwd.clone().multiplyScalar(spd).add(new THREE.Vector3(0, up, 0)).addScaledVector(this.player.vel, 0.6);
    this.explosives.throw(this.avatar, from, v, kind === 'frag' ? Math.max(0.25, this.explosives.fuseTime - cooked) : FUSE[kind], kind);
  }

  /** Equipment with its own viewmodel action (sticky, C4, claymore, snapshot, decoy). */
  private startEquip(item: GrenadeKind | 'claymore' | 'tknife', action: ActionType, dur: number, events: [number, string][], data?: { holdAt: number; hold: () => boolean }, onDone?: () => void) {
    this.player.sprinting = false;
    this.player.tactical = false;
    this.cookStart = -1;
    this.vm.detonatorOut = false;
    if (item !== 'claymore') this.throwKind = item;
    this.vm.holdItem(item);
    this.vm.play(action, dur, events, onDone, data);
  }
  private lastUseTap = -9;
  /** game-time timers (pause- and test-step-safe, unlike setTimeout) */
  private timers: { t: number; f: () => void }[] = [];
  later(delay: number, f: () => void) {
    this.timers.push({ t: this.time + delay, f });
  }
  private runTimers() {
    if (!this.timers.length) return;
    const due = this.timers.filter((x) => x.t <= this.time);
    if (!due.length) return;
    this.timers = this.timers.filter((x) => x.t > this.time);
    for (const d of due) d.f();
  }
  private myC4() {
    return this.explosives.grenades.filter((g) => g.kind === 'c4' && g.owner === this.avatar);
  }
  /** C4 remote: the detonator comes up, cover flips, clack — every charge you have out goes off. */
  private startDetonate() {
    const vm = this.vm;
    if (vm.action && vm.action.type !== 'inspect') {
      // mid-action: just fire the remote
      this.detonateMine();
      return;
    }
    if (vm.detonatorOut) {
      // already in hand: flip and press
      vm.play('detPress', 0.42, [], () => {
        if (!this.myC4().length) vm.detonatorOut = false;
      });
      return;
    }
    vm.holdItem('detonator');
    vm.play('detonate', 0.72, [[0.04, 'cloth'], [0.27, 'coverFlip'], [0.42, 'detonate']]);
  }
  private detonateMine() {
    const list = this.myC4();
    if (!list.length) return;
    this.audio.play('clack', { gain: 0.8, reverb: 0 });
    // a radio chirp, then each charge a beat apart
    list.forEach((g, i) => this.later(0.09 + i * 0.11, () => this.explosives.detonate(g)));
    this.equipNet?.('det', {});
  }


  // ---- mortar designation: a laser from the designator to wherever you aim
  private updateDesignator() {
    const inp = this.input;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const hit = this.physics.raycast(this.camera.position, fwd, 450);
    const aim = hit ? hit.point : this.camera.position.clone().addScaledVector(fwd, 200);
    if (!this.laser) {
      this.laser = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 6, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.15, 0.08), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      this.laser.frustumCulled = false;
      const tex = this.mats.baker.raw('fx.laserdot', `void main(){ vec2 p = vUv*2.0-1.0; float r = length(p); float a = exp(-r*r*18.0) + exp(-r*r*3.0)*0.35; gl_FragColor = vec4(vec3(1.0), clamp(a,0.0,1.0)); }`, 64, false);
      this.laserDot = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(8, 0.3, 0.15), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
      this.scene.add(this.laser, this.laserDot);
    }
    // the beam leaves the designator's lens (viewmodel space projected into the world)
    const lens = this.vm.items.laser.getObjectByName('lens');
    let from = this.camera.position.clone().addScaledVector(fwd, 0.4).add(new THREE.Vector3(0, -0.12, 0));
    if (lens && this.vm.items.laser.visible) {
      const lp = lens.getWorldPosition(new THREE.Vector3());
      from = this.screenToWorld(lp.clone().project(this.vmCamera), lp.length());
    }
    const d = aim.distanceTo(from);
    this.laser.position.copy(from).lerp(aim, 0.5);
    this.laser.scale.set(1, d, 1);
    this.laser.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), aim.clone().sub(from).normalize());
    this.laser.visible = this.laserDot!.visible = this.vm.action?.type === 'designate' && this.vm.action.t > 0.3;
    this.laserDot!.position.copy(aim);
    this.laserDot!.scale.setScalar(0.4 + d * 0.012);
    const tooClose = aim.distanceTo(this.player.pos) < 14;
    this.ui.designatorHint(true, Math.round(aim.distanceTo(this.player.pos)), tooClose);
    if (inp.wasPressed('fire') && this.laser.visible) {
      if (tooClose) {
        this.audio.play('click', { gain: 0.4, bus: 'ui', reverb: 0 });
        this.ui.notify('TOO CLOSE', 'AIM FURTHER AWAY');
      } else if (this.streaks.use(this.avatar, 'mortar', this.time, aim)) {
        this.audio.play('uavPing', { gain: 0.4, bus: 'ui', reverb: 0, rate: 1.4 });
        this.endDesignate(true);
      }
    }
    if (inp.wasPressed('ads')) this.endDesignate(false);
  }

  private endDesignate(_used: boolean) {
    this.designating = false;
    if (this.laser) this.laser.visible = this.laserDot!.visible = false;
    this.ui.designatorHint(false, 0, false);
  }

  // ---- tactical effects
  private flashBang(p: THREE.Vector3, owner: Combatant) {
    this.fx.explosion(p, new THREE.Vector3(0, 1, 0), 0.25, 'concrete');
    this.fx.flashPop(p);
    const d = p.distanceTo(this.camera.position);
    this.audio.play('flashBang', { pos: p, gain: 1.0, ref: 10, reverb: 0.6, prio: 3, delay: true });
    const eye = this.camera.position;
    if (this.avatar.alive && d < 32 && this.physics.lineOfSight(p.clone().setY(p.y + 0.2), eye)) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const facing = Math.max(0, fwd.dot(p.clone().sub(eye).normalize()));
      let k = Math.pow(Math.max(0, 1 - d / 32), 0.6) * (0.3 + 0.7 * facing);
      if (owner === this.avatar) k *= 0.8;
      if (k > 0.05) {
        this.blindK = Math.max(this.blindK, Math.min(1, k * 1.25));
        this.blindT = Math.max(this.blindT, 0.6 + 3.2 * k);
        this.tinnitus = Math.max(this.tinnitus, Math.min(1, k * 1.1));
      }
    }
    for (const b of this.bots) {
      if (!b.alive) continue;
      const bd = b.eye(new THREE.Vector3()).distanceTo(p);
      if (bd < 26 && this.physics.lineOfSight(p.clone().setY(p.y + 0.2), b.eye(new THREE.Vector3()))) {
        const k = Math.max(0, 1 - bd / 26);
        b.blind(0.8 + 3.4 * k);
        if (owner === this.avatar && b.team !== this.avatar.team) this.ui.hitmarker(false, false, 10);
      }
    }
    this.alertBots(p, 40, -1);
  }

  private stunBlast(p: THREE.Vector3, owner: Combatant) {
    this.fx.explosion(p, new THREE.Vector3(0, 1, 0), 0.35, 'concrete');
    this.audio.play('stunBang', { pos: p, gain: 1.0, ref: 10, reverb: 0.6, prio: 3, delay: true });
    const eye = this.camera.position;
    const d = p.distanceTo(eye);
    if (this.avatar.alive && d < 13 && this.physics.lineOfSight(p.clone().setY(p.y + 0.2), eye)) {
      const k = Math.max(0, 1 - d / 13) * (owner === this.avatar ? 0.7 : 1);
      this.stunT = Math.max(this.stunT, 1.8 + 3.2 * k);
      this.rig.addTrauma(0.5 * k + 0.15);
      this.tinnitus = Math.max(this.tinnitus, 0.5 * k);
    }
    for (const b of this.bots) {
      if (!b.alive) continue;
      const bd = b.position().distanceTo(p);
      if (bd < 12 && this.physics.lineOfSight(p.clone().setY(p.y + 0.2), b.eye(new THREE.Vector3()))) {
        b.stun(1.8 + 3.2 * (1 - bd / 12));
        if (owner === this.avatar && b.team !== this.avatar.team) this.ui.hitmarker(false, false, 10);
      }
    }
    this.alertBots(p, 35, -1);
  }

  /** Thick, rolling smoke: big soft puffs swelling out of the canister and drifting with the wind. */
  private smokeAcc = new Map<SmokeCloud, number>();
  private emitSmoke(c: SmokeCloud, dt: number) {
    // (fewer, slightly bigger puffs on the lower presets: same cover, less overdraw)
    const q = Settings.data.quality;
    const rate = q === 'low' ? 0.5 : q === 'medium' ? 0.75 : 1;
    const acc = (this.smokeAcc.get(c) ?? 0) + dt * (c.t < 3 ? 16 : 7) * rate;
    let n = Math.floor(acc);
    this.smokeAcc.set(c, acc - n);
    const wind = this.weather.wind;
    while (n-- > 0) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * Math.max(0.5, c.r * 0.7);
      const p = c.p.clone().add(new THREE.Vector3(Math.cos(a) * r, 0.3 + Math.random() * Math.min(2.5, c.r * 0.4), Math.sin(a) * r));
      const v = new THREE.Vector3((Math.random() - 0.5) * 0.8 + wind.x * 0.05, 0.25 + Math.random() * 0.3, (Math.random() - 0.5) * 0.8 + wind.z * 0.05);
      const g = 0.7 + Math.random() * 0.12;
      this.fx.smokePuff(p, v, [g, g, g * 1.02], (2.2 + Math.random() * 1.8) / Math.sqrt(rate), 9 + Math.random() * 4);
    }
  }

  // ---- voice callouts (ElevenLabs-generated lines, see tools/voice_build.py)
  private voiceT = new Map<number, number>();
  private lastVoice = -9;
  botVoice(b: Bot, line: string) {
    if (!b.alive && line !== 'mandown') return;
    const t = this.time;
    if (t - (this.voiceT.get(b.id) ?? -9) < 3.5 || t - this.lastVoice < 0.6) return;
    const spk = `bot${b.team}${b.id % 2 === 0 ? 'a' : 'b'}`;
    const key = `vo_${spk}_${line}`;
    if (!this.audio.has(key)) return;
    // the bot is really talking in the world: you have to be near, walls muffle it, rooms colour it
    const p = b.eye(new THREE.Vector3());
    const d = p.distanceTo(this.camera.position);
    const range = b.team === this.avatar.team ? 34 : 30;
    if (d > range) return;
    this.voiceT.set(b.id, t);
    this.lastVoice = t;
    const occluded = d > 3 && !this.physics.lineOfSight(this.camera.position, p);
    const variant = Math.floor(Math.random() * (this.audio.voiceText[key]?.length ?? 1));
    // 12 soldiers per side share two recorded voices: a stable per-soldier pitch keeps them apart
    const rate = 0.93 + ((b.id * 7) % 6) * 0.028;
    this.audio.play(key, { pos: p, gain: occluded ? 0.75 : 1.1, ref: 4, reverb: occluded ? 0.5 : 0.3, prio: 2, maxDist: range, lowpass: occluded ? 1300 : undefined, variant, rate, vary: 0.01 });
    const text = this.audio.voiceText[key]?.[variant];
    if (text) this.ui.subtitle(b.name.toUpperCase(), text, b.team === this.avatar.team ? 'f' : 'e', d);
  }

  /** The player's own callouts (a voice no bot uses), with subtitles. */
  private pvT = new Map<string, number>();
  private pvLast = -9;
  playerVoice(line: string, chance = 1) {
    if (!this.avatar.alive || Math.random() > chance) return;
    const t = this.time;
    if (t - this.pvLast < 1.4 || t - (this.pvT.get(line) ?? -9) < 4) return;
    const key = `vo_player_${line}`;
    if (!this.audio.has(key)) return;
    this.pvLast = t;
    this.pvT.set(line, t);
    const variant = Math.floor(Math.random() * (this.audio.voiceText[key]?.length ?? 1));
    this.audio.play(key, { gain: 0.6, reverb: 0.12, prio: 2, variant, vary: 0.01, lowpass: 7000 });
    const text = this.audio.voiceText[key]?.[variant];
    if (text) this.ui.subtitle('YOU', text, 'me', 0);
    // teammates hear you too
    for (const m of this.bots) if (m.alive && m.team === this.avatar.team && line === 'frag') m.hear(this.player.pos);
  }
  radio!: Radio;
  private hq = new HQ();
  /** HQ on the radio net (queued with the pilot / operator, never over each other) */
  announcer(line: string) {
    const prio = line === 'win' || line === 'lose' ? 3 : /^(sec|lost|losing|minute)/.test(line) ? 2 : 1;
    this.radio.say('ann', line, this.time, { prio, cooldown: 3, ttl: prio >= 2 ? 5 : 8 });
  }
  private crew(spk: RadioSpk, line: string, o?: { prio?: number; cooldown?: number; ttl?: number }) {
    this.radio.say(spk, line, this.time, o);
  }

  private meleeHit(dmg = 135, weapon = MELEE.name, range = 2.6) {
    const eye = this.camera.position;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    let best: Bot | null = null, bd = range;
    for (const b of this.bots) {
      if (!b.alive || b.team === this.avatar.team) continue;
      const c = b.chest(new THREE.Vector3());
      const to = c.clone().sub(eye);
      const d = to.length();
      if (d > bd || to.normalize().dot(fwd) < 0.55 || !this.physics.lineOfSight(eye, c)) continue;
      bd = d;
      best = b;
    }
    if (!best) {
      // hit a wall? a dull knock
      const wall = this.physics.raycast(eye, fwd, 1.6);
      if (wall) {
        this.audio.play('imp_wood', { gain: 0.6, rate: 0.8, reverb: 0.1 });
        this.rig.addTrauma(0.12);
      }
      return;
    }
    // lunge the last half metre
    this.player.vel.addScaledVector(fwd.clone().setY(0).normalize(), Math.min(6, bd * 2.5));
    const dir = best.chest(new THREE.Vector3()).sub(eye).normalize();
    const before = best.health;
    best.health = Math.max(0, best.health - dmg);
    best.onDamaged(this.avatar, dmg, dir, 'body');
    this.audio.play('knife', { gain: 0.95, reverb: 0.05, vary: 0.05, prio: 3 });
    this.rig.addTrauma(0.28);
    this.fx.impact(best.chest(new THREE.Vector3()), dir.clone().negate(), 'flesh', dir, true);
    if (before > 0 && best.health <= 0) {
      best.alive = false;
      this.onKill(this.avatar, best, weapon, false, false);
    } else this.ui.hitmarker(false, false, dmg);
  }

  /**
   * Knife attack with the dedicated knife: if an enemy is inside lunge range the takedown is chosen
   * from how you reached them (falling onto them, sliding in, standing over a low target, behind,
   * at the flank, or face to face); the victim is held and the view turned onto them.
   */
  private knifeAttack(_kind: 'slash' | 'stab'): boolean {
    if (this.knifeK || !this.avatar.alive) return !!this.knifeK;
    const eye = this.camera.position;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    let best: Bot | null = null, bd = 3.0;
    for (const b of this.bots) {
      if (!b.alive || b.team === this.avatar.team || b.heldT > 0) continue;
      const c = b.chest(new THREE.Vector3());
      const to = c.clone().sub(eye);
      const d = to.length();
      if (d > bd || to.normalize().dot(fwd) < 0.5 || !this.physics.lineOfSight(eye, c)) continue;
      bd = d;
      best = b;
    }
    if (!best) return false;
    const pl = this.player;
    const vp = best.position();
    const toV = vp.clone().sub(pl.pos).setY(0);
    if (toV.lengthSq() < 1e-4) toV.set(-Math.sin(pl.yaw), 0, -Math.cos(pl.yaw));
    toV.normalize();
    const vf = best.lookDir(new THREE.Vector3()).setY(0).normalize();
    const along = vf.dot(toV); // +1: they face away from you, -1: they face you
    const height = pl.pos.y - vp.y;
    let kind: KnifeKill;
    if (!pl.grounded && (pl.vel.y < -1.2 || height > 0.7)) kind = 'air';
    else if (pl.sliding || pl.diving) kind = 'slide';
    else if (best.crouch || height > 0.65) kind = 'down';
    else if (along > 0.35) kind = 'back';
    else if (Math.abs(along) < 0.45) kind = 'side';
    else kind = 'front';
    const T = KILL_TIMING[kind];
    const yawTo = Math.atan2(-toV.x, -toV.z);
    const dist = kind === 'back' ? 0.72 : kind === 'front' ? 0.85 : kind === 'side' ? 0.8 : kind === 'down' ? 0.78 : 0.9;
    if (kind === 'air' || kind === 'slide') best.hold(vp, best.yaw, T.hit * T.dur + 0.1);
    else {
      const hp = pl.pos.clone().addScaledVector(toV, Math.min(dist, Math.max(0.5, Math.hypot(vp.x - pl.pos.x, vp.z - pl.pos.z))));
      hp.y = vp.y;
      const side = Math.sign(new THREE.Vector3().crossVectors(toV, vf).y) || 1;
      const vy = kind === 'back' ? yawTo : kind === 'front' ? yawTo + Math.PI : kind === 'side' ? yawTo + side * Math.PI / 2 : best.yaw;
      best.hold(hp, vy, T.dur);
    }
    const froze = kind !== 'air' && kind !== 'slide';
    if (froze) pl.frozen = true;
    this.knifeK = { victim: best, kind, t: 0, dur: T.dur, lock: T.lock, done: false, froze };
    this.vm.play('knifeKill', T.dur, [[0.04, 'swish'], [T.hit, 'kHit']], undefined, { kind });
    this.audio.play('cloth', { gain: 0.6, reverb: 0 });
    if (kind === 'back') this.audio.play('breathIn', { gain: 0.5, reverb: 0, rate: 1.1 });
    return true;
  }

  private updateKnife(dt: number) {
    const k = this.knifeK;
    if (!k) return;
    k.t += dt;
    const pl = this.player;
    if (!k.done && k.victim.alive) {
      // the view is drawn onto the victim (throat height) during the approach
      const c = k.victim.chest(new THREE.Vector3());
      c.y += k.kind === 'down' ? -0.15 : 0.18;
      const d = c.sub(this.camera.position);
      const wy = Math.atan2(-d.x, -d.z), wp = Math.atan2(d.y, Math.hypot(d.x, d.z));
      let dy = wy - pl.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const a = 1 - Math.exp(-dt * 12);
      pl.yaw += dy * a;
      pl.pitch += (THREE.MathUtils.clamp(wp, -1.2, 0.6) - pl.pitch) * a;
    }
    if (k.froze && (k.t >= k.lock || !this.avatar.alive)) {
      k.froze = false;
      pl.frozen = false;
    }
    if (k.t >= k.dur || !this.avatar.alive) {
      if (k.froze) pl.frozen = false;
      if (!k.done && k.victim.heldT > 0) k.victim.heldT = 0;
      this.knifeK = null;
    }
  }

  private knifeHit() {
    const k = this.knifeK;
    if (!k || k.done) return;
    k.done = true;
    const v = k.victim;
    if (!v.alive) return;
    v.heldT = 0;
    const eye = this.camera.position;
    const at = v.chest(new THREE.Vector3());
    if (k.kind === 'back' || k.kind === 'front') at.y += 0.25;
    const dir = at.clone().sub(eye).normalize();
    v.health = 0;
    v.onDamaged(this.avatar, 200, dir, k.kind === 'back' ? 'head' : 'body');
    v.alive = false;
    this.fx.impact(at, dir.clone().negate(), 'flesh', dir, true);
    this.fx.killBurst(v.chest(new THREE.Vector3()), dir, false, v.position().y);
    this.audio.play('knife', { gain: 1.0, reverb: 0.05, vary: 0.05, prio: 3 });
    this.audio.play('imp_flesh', { gain: 0.7, rate: 0.85, reverb: 0.02 });
    this.rig.addTrauma(k.kind === 'air' ? 0.5 : 0.32);
    if (k.kind === 'air') this.vm.landImpulse(9);
    this.onKill(this.avatar, v, 'Combat Knife', false, false);
  }

  private tknifeHit(victim: Combatant, by: Combatant, point: THREE.Vector3, dir: THREE.Vector3, part: HitPart) {
    if (!victim.alive) return;
    victim.health = 0;
    victim.onDamaged(by, 200, dir, part);
    victim.alive = false;
    this.fx.impact(point, dir.clone().negate(), 'flesh', dir, part === 'head');
    this.audio.play('knife', { pos: point, gain: 0.9, ref: 4, reverb: 0.05, vary: 0.05 });
    this.onKill(by, victim, 'Throwing Knife', part === 'head', false);
  }

  /** Killstreak visuals & sounds that live in the world: heli rotor loop, UAV knowledge. */
  private uavKnowT = 0;
  private updateStreakWorld(dt: number) {
    const heli = this.streaks.helis[0];
    if (heli) this.audio.loop('heli', Math.min(1, 1.4 - heli.pos.distanceTo(this.camera.position) / 260), heli.pos);
    else this.audio.loop('heli', 0);
    // an enemy UAV keeps bots informed of where the player is
    this.uavKnowT -= dt;
    if (this.uavKnowT <= 0) {
      this.uavKnowT = 2.5;
      for (const team of [0, 1] as const) {
        if (this.streaks.uavUntil[team] <= this.time) continue;
        for (const b of this.bots) if (b.alive && b.team === team && !b.target && Math.random() < 0.35) {
          const foes = this.match.players.filter((p) => p.alive && p.team !== team);
          const f = foes.sort((x, y) => x.position().distanceTo(b.position()) - y.position().distanceTo(b.position()))[0];
          if (f) b.hear(f.position());
        }
      }
    }
    // bots run from grenades near them; the player gets a HUD warning
    const warn: number[] = [];
    for (const g of this.explosives.grenades) {
      if (g.kind === 'decoy' || g.kind === 'snapshot') continue; // they look like nothing worth running from
      for (const b of this.bots) {
        if (b.alive && g.fuse < 2.6 && b.position().distanceTo(g.pos) < 7) {
          if (b.state !== 'cover' && (g.kind === 'frag' || g.kind === 'sticky') && g.owner.team !== b.team) this.botVoice(b, 'grenade');
          b.flee(g.pos);
        }
      }
      if (this.avatar.alive && g.owner !== this.avatar && g.pos.distanceTo(this.player.pos) < 9) {
        const to = g.pos.clone().sub(this.player.pos);
        warn.push(Math.atan2(to.x, -to.z) + this.player.yaw);
      }
    }
    this.ui.grenadeWarn(warn);
    this.tinnitus = Math.max(0, this.tinnitus - dt * 0.25);
    this.audio.tinnitus = this.tinnitus;
    // HUD
    const n = this.streaks.count(this.avatar);
    this.ui.updateStreaks(STREAKS.map((s) => ({ name: s.name, key: s.key, kills: s.kills, ready: this.streaks.has(this.avatar, s.id), active: false })), n);
    this.ui.updateNades(this.frags, this.cookStart >= 0 && this.throwKind === 'frag' ? Math.max(0, this.explosives.fuseTime - (this.time - this.cookStart)) : 0, this.loadout.tactical, this.tacCount, this.loadout.lethal, this.fieldCharge, this.loadout.lethal === 'c4' ? this.myC4().length : 0);
  }

  // ================================================================ domination glue
  private flagSpawnBias(p: THREE.Vector3, team: 0 | 1) {
    let s = 0;
    for (const f of this.dom.flags) {
      const d = Math.hypot(p.x - f.pos.x, p.z - f.pos.z);
      // the fight belongs on the objectives (wherever on the map they are this match): spawn
      // behind the flags you hold, and on the approach to neutral ones
      if (f.owner === team) {
        s += 75 * Math.exp(-Math.pow((d - 32) / 24, 2));
        if (d < f.radius + 4) s -= 25;
      } else if (f.owner !== -1) {
        if (d < 50) s -= 90 * (1 - d / 50);
      } else {
        if (d < 22) s -= 20;
        else s += 30 * Math.exp(-Math.pow((d - 55) / 25, 2));
      }
    }
    return s;
  }

  private onFlagEvent(e: FlagEvent) {
    const mine = e.team === this.avatar.team;
    const f = e.flag;
    if (e.kind === 'captured') {
      for (const c of e.by) if (c.team === e.team) c.score += 200;
      this.announcer(mine ? `sec${f.letter}` : `lost${f.letter}`);
      if (mine) {
        this.ui.announce(`${f.letter} SECURED`, f.name.toUpperCase(), 'good');
        this.audio.play('flagWon', { gain: 0.55, bus: 'ui', reverb: 0 });
        if (e.by.includes(this.avatar)) this.ui.killText(200, [`CAPTURED ${f.letter}`]);
      } else {
        this.ui.announce(`ENEMY TOOK ${f.letter}`, f.name.toUpperCase(), 'bad');
        this.audio.play('flagLost', { gain: 0.55, bus: 'ui', reverb: 0 });
      }
    } else {
      if (mine) {
        this.ui.announce(`${f.letter} NEUTRALIZED`, '', 'good');
        this.audio.play('radio', { gain: 0.4, bus: 'ui', reverb: 0 });
        if (e.by.includes(this.avatar)) this.ui.killText(50, [`NEUTRALIZED ${f.letter}`]);
      } else {
        this.announcer(`losing${f.letter}`);
        this.ui.announce(`LOSING ${f.letter}`, f.name.toUpperCase(), 'bad');
        this.audio.play('flagLost', { gain: 0.4, bus: 'ui', reverb: 0, rate: 1.1 });
      }
    }
  }

  private capTickT = 0;
  private capCalled = '';
  private lowCalled = false;
  private updateDominationHUD(dt: number) {
    const my = this.avatar.team;
    const rel = (o: -1 | 0 | 1) => (o === -1 ? 'n' : o === my ? 'f' : 'e') as 'f' | 'e' | 'n';
    const cam = this.camera;
    const w = window.innerWidth, h = window.innerHeight;
    const here = this.avatar.alive ? this.dom.flagAt(this.player.pos) : null;
    const marks = this.dom.flags.map((f) => {
      const top = f.pos.clone().setY(f.pos.y + 4.6);
      const v = top.clone().project(cam);
      const behind = v.z > 1 || cam.position.clone().sub(top).dot(cam.getWorldDirection(new THREE.Vector3())) > 0;
      let x = v.x, y = v.y;
      if (behind) {
        x = -x;
        y = -Math.abs(y) - 0.5;
      }
      const m = Math.max(Math.abs(x) / 0.94, Math.abs(y) / 0.9, 1);
      const edge = behind || m > 1;
      x /= m;
      y /= m;
      let sx = (x * 0.5 + 0.5) * w, sy = (-y * 0.5 + 0.5) * h;
      // through a scope: inside the lens the picture is magnified — put the marker where the flag
      // really is in the glass, or out on the lens rim if the glass does not show it
      const sc = this.weapons.scopeActive && this.scope.active ? this.scopeScreen : null;
      if (sc && !behind) {
        const at = this.markerAt(top);
        if (at) {
          sx = at.x;
          sy = at.y;
        } else {
          const dx = sx - sc.cx, dy = sy - sc.cy, d = Math.hypot(dx, dy);
          if (d < sc.r * 1.05) {
            const k = (sc.r * 1.08) / Math.max(1, d);
            sx = sc.cx + dx * k;
            sy = sc.cy + dy * k;
          }
        }
      }
      return { x: sx, y: sy, letter: f.letter, rel: rel(f.owner), dist: f.pos.distanceTo(this.player.pos), edge, here: f === here };
    });
    let cap: { text: string; progress: number; rel: 'f' | 'e' | 'n'; letter: string } | null = null;
    if (here) {
      const f: Flag = here;
      const text = f.contested ? 'CONTESTED' : f.capTeam === my ? (f.owner === -1 ? 'CAPTURING' : 'NEUTRALIZING') : f.capTeam !== -1 ? 'LOSING' : f.owner === my ? 'SECURED' : 'CAPTURING';
      const progress = f.capTeam !== -1 ? f.progress : f.owner === my ? 1 : 0;
      cap = { text, progress, rel: f.contested ? 'n' : f.capTeam !== -1 ? rel(f.capTeam) : rel(f.owner), letter: f.letter };
      if (f.capTeam === my && !f.contested && f.progress < 0.15 && this.capCalled !== f.letter) {
        this.capCalled = f.letter;
        this.playerVoice('capture', 0.8);
      }
      if (f.capTeam === my && !f.contested) {
        this.capTickT -= dt;
        if (this.capTickT <= 0) {
          this.capTickT = 0.5;
          this.audio.play('capTick', { gain: 0.25, bus: 'ui', reverb: 0, rate: 0.9 + f.progress * 0.5 });
        }
      }
    }
    for (const f of this.dom.flags) {
      if (f.capTeam === -1 || f.contested || Math.random() > dt * 0.4) continue;
      const b = this.bots.find((x) => x.alive && x.team === f.capTeam && this.dom.inZone(f, x.position()));
      if (b) this.botVoice(b, `cap${f.letter}`);
    }
    this.ui.updateFlags(
      this.dom.flags.map((f) => ({ letter: f.letter, rel: rel(f.owner), cap: rel(f.capTeam), progress: f.capTeam === -1 ? 0 : f.progress, contested: f.contested })),
      marks,
      cap,
    );
  }

  // ================================================================ combat glue
  groundHeightAt(x: number, z: number) {
    const h = this.physics.raycast(new THREE.Vector3(x, this.terrain.heightAt(x, z) + 6, z), new THREE.Vector3(0, -1, 0), 14);
    return h ? h.point.y : this.terrain.heightAt(x, z);
  }

  private indoorTimer = 0;
  private indoorTarget = 0;
  private roomTarget = { outdoor: 1, small: 0, hall: 0, tunnel: 0 };
  private updateIndoor(dt: number) {
    this.indoorTimer -= dt;
    if (this.indoorTimer <= 0) {
      this.indoorTimer = 0.15;
      const eye = this.camera.position;
      const up = this.physics.raycast(eye, new THREE.Vector3(0, 1, 0), 30);
      const sun = this.physics.raycast(eye, this.env.sunDir, 200);
      this.indoorTarget = up ? 0.85 : sun ? 0.45 : 0;
      // acoustic probe: how enclosed is the listener and how big is the space?
      let hits = 0, sum = 0, minAxis = 99, maxAxis = 0;
      const dists: number[] = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const h = this.physics.raycast(eye, new THREE.Vector3(Math.cos(a), 0.05, Math.sin(a)), 40);
        const d = h ? h.distance : 40;
        dists.push(d);
        if (h) {
          hits++;
          sum += d;
        }
      }
      for (let i = 0; i < 4; i++) {
        const w = Math.min(dists[i], dists[i + 4]) + Math.max(dists[i], dists[i + 4]);
        minAxis = Math.min(minAxis, w);
        maxAxis = Math.max(maxAxis, w);
      }
      const ceil = up ? up.distance : 99;
      const enclosure = hits / 8;
      const avg = hits ? sum / hits : 40;
      const r = { outdoor: 0, small: 0, hall: 0, tunnel: 0 };
      if (!up || enclosure < 0.45) r.outdoor = 1;
      else if (minAxis < 20 && maxAxis > 28 && ceil < 11) r.tunnel = 1;
      else if (ceil > 4.5 || avg > 7) r.hall = 1;
      else r.small = 1;
      this.roomTarget = r;
    }
    this.indoor += (this.indoorTarget - this.indoor) * (1 - Math.exp(-4 * dt));
    const k = 1 - Math.exp(-3 * dt);
    const rm = this.audio.room;
    for (const key of ['outdoor', 'small', 'hall', 'tunnel'] as const) rm[key] += (this.roomTarget[key] - rm[key]) * k;
  }

  screenToWorld(ndc: THREE.Vector3, dist: number) {
    const p = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(this.camera);
    const o = this.camera.position;
    return p.sub(o).normalize().multiplyScalar(dist).add(o);
  }

  private lastShotT = -99;
  private onPlayerShot(req: ShotRequest) {
    const d = req.def;
    this.lastShotT = this.time;
    this.firedSinceSpawn = true;
    const muzzle = this.screenToWorld(req.muzzleScreen, 0.9);
    this.fx.muzzleWorld(muzzle, req.dirs[0], !!d.sound.suppressed, d.cls === 'Shotgun' ? 1.4 : 1);
    this.gunshot(d, null, 0, false);
    if (d.modes[0] !== 'pump' && d.modes[0] !== 'bolt' && d.id !== 'rv357' && d.action !== 'break') this.ejectCasing(req, d);
    for (let i = 0; i < req.dirs.length; i++) this.ballistics.fire(this.avatar, req.origin, req.dirs[i], d, muzzle, req.tracer && (i === 0 || i % 3 === 0));
    this.recorder.shot({ t: this.time, id: this.bots.length, origin: req.origin.clone(), dir: req.dirs[0].clone(), muzzle: muzzle.clone(), def: d.id });
    this.alertBots(this.player.pos, d.sound.suppressed ? 25 : 90, this.avatar.team);
    if (!d.sound.suppressed) this.radarPing(this.avatar, this.player.pos);
    for (const dir of req.dirs) this.shootLights(req.origin, dir);
    this.gunEcho(this.camera.position, d, 1);
    this.noteGunfire(this.player.pos);
  }

  private onBotShot(bot: Bot, origin: THREE.Vector3, dir: THREE.Vector3, def: WeaponDef, muzzle: THREE.Vector3) {
    if (this.time - (this.lastBotShot.get(bot.id) ?? -1) > 0.03) this.recorder.shot({ t: this.time, id: this.bots.indexOf(bot), origin: origin.clone(), dir: dir.clone(), muzzle: muzzle.clone(), def: def.id });
    // every bot bullet is a real projectile too (travel time, drop, drag, wind)
    this.ballistics.fire(bot, origin, dir, def, muzzle, def.cls === 'Sniper' || this.rng.next() < 0.22);
    const cam = this.camera.position;
    const dist = muzzle.distanceTo(cam);
    const last = this.lastBotShot.get(bot.id) ?? -1;
    const firstPellet = this.time - last > 0.03;
    if (firstPellet) {
      this.lastBotShot.set(bot.id, this.time);
      this.fx.muzzleWorld(muzzle, dir, !!def.sound.suppressed, def.cls === 'Sniper' ? 0.9 : 0.8);
      const key = dist > 120 ? `far_${def.id}` : `shot_${def.id}`;
      this.shootLights(origin, dir);
      if (dist < 110 && this.rng.next() < 0.6) this.gunEcho(muzzle, def, 0.65 * (1 - dist / 110));
      // occlusion: a shot behind walls (e.g. you're inside, the fight is outside) is dull and quieter
      const occluded = dist > 4 && dist < 250 && !this.physics.lineOfSight(cam, muzzle);
      void key;
      this.gunshot(def, muzzle, dist, occluded);
      // brass from soldiers firing close by (pump / bolt guns eject when cycled, not here)
      const mode = def.modes[0];
      if (dist < 24 && mode !== 'pump' && mode !== 'bolt' && def.id !== 'db12' && def.id !== 'rv357') {
        const ej = (bot.weapon.sockets.eject ?? bot.weapon.sockets.muzzle).getWorldPosition(new THREE.Vector3());
        const r = new THREE.Vector3(Math.cos(bot.aimYaw), 0, -Math.sin(bot.aimYaw));
        const v = r.multiplyScalar(2 + Math.random()).add(new THREE.Vector3(0, 1.5 + Math.random(), 0)).add(bot.velocity.clone().setY(0));
        this.fx.shell(ej, v, def.cls === 'Pistol' || def.cls === 'SMG' ? 'pistol' : def.cls === 'Sniper' || def.cls === 'Marksman' ? 'big' : def.cls === 'Shotgun' ? 'shotgun' : 'rifle');
      }
    }
    // near-miss whiz & suppression on the player (bullets passing within 2.5 m with a clear line)
    if (bot.team !== this.avatar.team && this.avatar.alive) {
      const t = cam.clone().sub(origin).dot(dir);
      if (t > 2 && t < 400) {
        const closest = origin.clone().addScaledVector(dir, t);
        const miss = closest.distanceTo(cam);
        if (miss < 2.5 && miss > 0.35 && this.physics.lineOfSight(origin, closest)) {
          this.audio.play('whiz', { pos: closest, gain: 0.8, ref: 2, reverb: 0, delay: true });
          this.suppression = Math.min(1, this.suppression + (def.cls === 'Sniper' ? 0.5 : 0.25));
          this.rig.addTrauma(def.cls === 'Sniper' ? 0.18 : 0.08);
        }
      }
    }
    const loud = def.cls === 'Sniper' ? 90 : def.cls === 'Marksman' ? 85 : def.sound.suppressed ? 20 : 80;
    this.alertBots(bot.position(), loud, bot.team);
    if (!def.sound.suppressed) this.radarPing(bot, bot.position());
    this.noteGunfire(bot.position());
  }

  radarPing(c: Combatant, _p: THREE.Vector3) {
    this.pings.set(c.id, this.time);
  }

  // ---------------- tactical map ----------------
  private setMapOpen(v: boolean) {
    if (!this.tmap) return;
    if (v && this.state !== 'playing') return;
    if (v === this.tmap.open) return;
    this.tmap.setOpen(v, this.player.pos.x, this.player.pos.z);
    this.input.mapMode = v;
    if (!v) {
      this.input.forget('fire');
      this.input.forget('ads');
    }
    this.audio.play('click', { gain: 0.3, bus: 'ui', reverb: 0, rate: v ? 1.25 : 0.95 });
    this.audio.play('cloth', { gain: 0.25, bus: 'ui', reverb: 0, rate: 1.3 });
  }

  /** surface point (roof, deck or ground) under a map position */
  private surfaceAt(x: number, z: number) {
    const hit = this.physics.raycast(new THREE.Vector3(x, 140, z), new THREE.Vector3(0, -1, 0), 300);
    return new THREE.Vector3(x, hit ? hit.point.y : this.terrain.heightAt(x, z), z);
  }

  /** a location ping placed on the map: the team sees it, idle teammates drift over */
  private mapPing(x: number, z: number) {
    const at = this.surfaceAt(x, z);
    this.worldPings = this.worldPings.filter((p) => p.until > this.time).slice(-2);
    this.worldPings.push({ pos: at, until: this.time + 12 });
    this.audio.play('click', { gain: 0.35, bus: 'ui', reverb: 0, rate: 1.5 });
    this.playerVoice('pingSpot', 0.8);
    for (const m of this.bots) if (m.alive && m.team === this.avatar.team && !m.target && m.position().distanceTo(at) < 120 && Math.random() < 0.4) m.hear(at);
  }

  private setWaypoint(p: { x: number; z: number } | null) {
    this.waypoint = p ? this.surfaceAt(p.x, p.z) : null;
    this.audio.play('click', { gain: 0.35, bus: 'ui', reverb: 0, rate: p ? 1.7 : 0.8 });
  }

  /** feed the tactical map (only while it is open) */
  private updateMapView(dt: number) {
    if (!this.tmap?.open) return;
    const team = this.avatar.team;
    const p = this.player.pos;
    const st: MapState = {
      px: p.x, pz: p.z, yaw: this.player.yaw, alive: this.avatar.alive,
      allies: [], enemies: [], flags: [], helis: [], pings: [],
      waypoint: this.waypoint ? { x: this.waypoint.x, z: this.waypoint.z } : null,
      uav: Math.max(0, this.streaks.uavUntil[team] - this.time),
      scores: this.match.scores, teamNames: this.match.teamNames, team,
      timeLeft: `${Math.floor(Math.max(0, this.match.timeLeft) / 60)}:${String(Math.floor(Math.max(0, this.match.timeLeft) % 60)).padStart(2, '0')}`,
      mode: 'Domination',
    };
    for (const b of this.bots) {
      if (!b.alive) continue;
      const bp = b.position();
      if (b.team === team) {
        st.allies.push({ x: bp.x, z: bp.z, yaw: b.yaw, name: b.name });
        continue;
      }
      const spottedUntil = this.spotted.get(b.id) ?? 0;
      const fired = this.time - (this.pings.get(b.id) ?? -99);
      if (spottedUntil > this.time) st.enemies.push({ x: bp.x, z: bp.z, kind: 'spotted', alpha: 1 });
      else if (st.uav > 0) st.enemies.push({ x: bp.x, z: bp.z, kind: 'uav', alpha: Math.max(0.35, 1 - (this.time % 2) / 2) });
      else if (fired < 2.2 && Math.hypot(bp.x - p.x, bp.z - p.z) < FIRE_REVEAL_RADIUS) st.enemies.push({ x: bp.x, z: bp.z, kind: 'fire', alpha: 1 - fired / 2.2 });
    }
    for (const fp of this.fakePings) {
      const age = this.time - fp.t;
      if (age < 2.2 && Math.hypot(fp.x - p.x, fp.z - p.z) < FIRE_REVEAL_RADIUS) st.enemies.push({ x: fp.x, z: fp.z, kind: 'fire', alpha: 1 - age / 2.2 });
    }
    for (const f of this.dom.flags) {
      const col = (o: number) => (o === -1 ? '#dddddd' : o === team ? '#5aa8ff' : '#ff4a3a');
      st.flags.push({ x: f.pos.x, z: f.pos.z, r: f.radius, letter: f.letter, color: col(f.owner), capColor: f.capTeam === -1 ? null : col(f.capTeam), progress: f.progress, contested: f.contested });
    }
    for (const hl of this.streaks.helis) st.helis.push({ x: hl.pos.x, z: hl.pos.z, friendly: hl.team === team });
    for (const pg of this.worldPings) if (pg.until > this.time) st.pings.push({ x: pg.pos.x, z: pg.pos.z, t: pg.until - this.time });
    this.tmap.draw(st, dt);
  }

  /** Spot: mark the enemy closest to the crosshair (in sight, within ~5°). */
  private trySpot() {
    const eye = this.camera.position;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    let best: Bot | null = null;
    let ba = Math.cos((5 * Math.PI) / 180);
    for (const b of this.bots) {
      if (!b.alive || b.team === this.avatar.team) continue;
      const c = b.chest(new THREE.Vector3());
      const to = c.clone().sub(eye);
      const d = to.length();
      if (d > 180) continue;
      const dot = to.divideScalar(d).dot(fwd);
      if (dot > ba && this.physics.lineOfSight(eye, c)) {
        ba = dot;
        best = b;
      }
    }
    if (best) {
      this.spotted.set(best.id, this.time + 7);
      this.ui.notify('ENEMY SPOTTED', best.name.toUpperCase());
      this.audio.play('medal', { gain: 0.18, bus: 'ui', reverb: 0, rate: 1.6 });
      // teammates hear about it
      for (const m of this.bots) if (m.alive && m.team === this.avatar.team && !m.target) m.hear(best.position());
    } else this.audio.play('click', { gain: 0.3, bus: 'ui', reverb: 0 });
  }

  /**
   * Ping [X / middle mouse]: an enemy near the crosshair gets marked for the team and called out;
   * otherwise a location marker is dropped where you look ("over here").
   */
  private ping() {
    const before = this.spotted.size;
    const eye = this.camera.position;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    let best: Bot | null = null;
    let ba = Math.cos((6 * Math.PI) / 180);
    for (const b of this.bots) {
      if (!b.alive || b.team === this.avatar.team) continue;
      const c = b.chest(new THREE.Vector3());
      const to = c.clone().sub(eye);
      const d = to.length();
      if (d > 220) continue;
      const dot = to.divideScalar(d).dot(fwd);
      if (dot > ba && this.physics.lineOfSight(eye, c)) {
        ba = dot;
        best = b;
      }
    }
    void before;
    if (best) {
      this.spotted.set(best.id, this.time + 8);
      this.ui.notify('ENEMY PINGED', best.name.toUpperCase());
      this.audio.play('medal', { gain: 0.2, bus: 'ui', reverb: 0, rate: 1.8 });
      this.playerVoice('pingEnemy');
      for (const m of this.bots) if (m.alive && m.team === this.avatar.team && !m.target) m.hear(best.position());
      return;
    }
    const hit = this.physics.raycast(eye, fwd, 300);
    const at = hit ? hit.point.clone() : eye.clone().addScaledVector(fwd, 60);
    this.worldPings = this.worldPings.filter((p) => p.until > this.time).slice(-2);
    this.worldPings.push({ pos: at, until: this.time + 7 });
    this.audio.play('click', { gain: 0.35, bus: 'ui', reverb: 0, rate: 1.5 });
    this.playerVoice('pingSpot', 0.8);
    // friendlies with nothing to do drift over to have a look
    for (const m of this.bots) if (m.alive && m.team === this.avatar.team && !m.target && m.position().distanceTo(at) < 80 && Math.random() < 0.35) m.hear(at);
  }

  /** lens circle on screen (px) while a PiP scope is up */
  private scopeScreen = { cx: 0, cy: 0, r: 0 };
  /**
   * Where a world point shows on screen for the HUD markers. Through a scope the picture in the
   * lens is a separate, magnified camera: project with that camera into the lens circle (and hide
   * what the lens does not show), so names sit on the soldiers you actually see in the glass.
   */
  private markerAt(p: THREE.Vector3): { x: number; y: number; scoped: boolean } | null {
    const w = window.innerWidth, h = window.innerHeight;
    if (this.weapons.scopeActive && this.scope.active && this.scopeScreen.r > 4) {
      const n = p.clone().project(this.scope.cam);
      if (n.z >= 1 || n.x * n.x + n.y * n.y > 0.85) return null;
      return { x: this.scopeScreen.cx + n.x * this.scopeScreen.r, y: this.scopeScreen.cy - n.y * this.scopeScreen.r, scoped: true };
    }
    const n = p.clone().project(this.camera);
    if (n.z >= 1 || Math.abs(n.x) > 1.05 || Math.abs(n.y) > 1.05) return null;
    return { x: (n.x * 0.5 + 0.5) * w, y: (-n.y * 0.5 + 0.5) * h, scoped: false };
  }

  /** Radar blips and 3D markers (teammate nameplates, spotted enemies). */
  private updateRadar(dt: number) {
    const p = this.player.pos;
    const blips: RadarBlip[] = [];
    const items: { x: number; y: number; text: string; cls: string; alpha: number }[] = [];
    const w = window.innerWidth, h = window.innerHeight;
    const cam = this.camera;
    // aiming: compact plates, and the ones right on the crosshair fade so they never hide a target
    const ads = this.weapons.ads;
    const aimCls = this.weapons.scopeActive && this.scope.active ? ' ads scoped' : ads > 0.5 ? ' ads' : '';
    const nearAim = (x: number, y: number) => {
      if (ads < 0.5) return 1;
      const d = Math.hypot(x - w / 2, y - h / 2) / h;
      return 0.3 + 0.7 * smooth01((d - 0.03) / 0.09);
    };

    for (const b of this.bots) {
      if (!b.alive) continue;
      const bp = b.position();
      if (b.team === this.avatar.team) {
        blips.push({ x: bp.x, z: bp.z, kind: 'ally', alpha: 1 });
        const head = bp.clone().setY(bp.y + 2.05);
        const d = head.distanceTo(cam.position);
        const at = d < (aimCls ? 160 : 90) ? this.markerAt(head) : null;
        if (at) items.push({ x: at.x, y: at.y, text: b.name.toUpperCase(), cls: 'ally' + aimCls, alpha: Math.max(0.3, 1 - d / (aimCls ? 170 : 100)) * nearAim(at.x, at.y) });
      } else {
        const spottedUntil = this.spotted.get(b.id) ?? 0;
        const ping = this.time - (this.pings.get(b.id) ?? -99);
        if (spottedUntil > this.time) {
          blips.push({ x: bp.x, z: bp.z, kind: 'spotted', alpha: 1 });
          const head = bp.clone().setY(bp.y + 2.1);
          const at = this.markerAt(head);
          if (at) items.push({ x: at.x, y: at.y, text: 's', cls: 'spotted' + aimCls, alpha: Math.min(1, (spottedUntil - this.time) * 2) * nearAim(at.x, at.y) });
        } else if (ping < 2.2 && bp.distanceTo(p) < FIRE_REVEAL_RADIUS) blips.push({ x: bp.x, z: bp.z, kind: 'ping', alpha: 1 - ping / 2.2 }); // gunfire is only heard nearby
        else if (this.streaks.uavUntil[this.avatar.team] > this.time) {
          // UAV sweep: every enemy blinks up each 2 s
          const ph = (this.time % 2) / 2;
          blips.push({ x: bp.x, z: bp.z, kind: 'ping', alpha: Math.max(0.25, 1 - ph) });
        }
      }
    }
    // enemy decoys: fake fire contacts, indistinguishable from the real thing
    for (const fp of this.fakePings) {
      const age = this.time - fp.t;
      if (age < 2.2 && Math.hypot(fp.x - p.x, fp.z - p.z) < FIRE_REVEAL_RADIUS) blips.push({ x: fp.x, z: fp.z, kind: 'ping', alpha: 1 - age / 2.2 });
    }
    for (const f of this.dom.flags) blips.push({ x: f.pos.x, z: f.pos.z, kind: 'flag', alpha: 1, label: f.letter, color: f.owner === -1 ? '#dddddd' : f.owner === this.avatar.team ? '#5aa8ff' : '#ff4a3a' });
    for (const hl of this.streaks.helis) blips.push({ x: hl.pos.x, z: hl.pos.z, kind: hl.team === this.avatar.team ? 'heli' : 'heliFoe', alpha: 1 });
    for (const pg of this.worldPings) {
      if (pg.until <= this.time) continue;
      const top = pg.pos.clone().setY(pg.pos.y + 0.4);
      blips.push({ x: pg.pos.x, z: pg.pos.z, kind: 'ping', alpha: 1 });
      const at = this.markerAt(top);
      if (at) items.push({ x: at.x, y: at.y, text: `${Math.round(pg.pos.distanceTo(cam.position))}m`, cls: 'pingmark' + aimCls, alpha: Math.min(1, (pg.until - this.time) * 2) * nearAim(at.x, at.y) });
    }
    if (this.waypoint) {
      const wp = this.waypoint;
      if (Math.hypot(wp.x - p.x, wp.z - p.z) < 6) this.waypoint = null;
      else {
        blips.push({ x: wp.x, z: wp.z, kind: 'ping', alpha: 1 });
        const at = this.markerAt(wp.clone().setY(wp.y + 1.2));
        if (at) items.push({ x: at.x, y: at.y, text: `WAYPOINT ${Math.round(wp.distanceTo(cam.position))}m`, cls: 'pingmark waypoint' + aimCls, alpha: nearAim(at.x, at.y) });
      }
    }
    this.markers.update(items);
    this.updateMapView(dt);
    this.radarT -= dt;
    if (this.radarT <= 0) {
      this.radarT = 1 / 30;
      this.radar.draw(p.x, p.z, this.player.yaw, blips);
    }
  }

  /** Lens glint on enemy snipers who are looking at the player. */
  private updateGlints() {
    let gi = 0;
    const cam = this.camera.position;
    for (const b of this.bots) {
      if (gi >= this.glints.length) break;
      if (!b.alive || b.team === this.avatar.team || !b.def.scope) continue;
      const sp = new THREE.Vector3();
      b.weapon.sockets.sight.getWorldPosition(sp);
      const to = cam.clone().sub(sp);
      const d = to.length();
      if (d < 25) continue;
      const facing = b.lookDir().dot(to.divideScalar(d));
      if (facing < 0.93) continue;
      const g = this.glints[gi++];
      g.visible = true;
      g.position.copy(sp);
      const flick = 0.75 + 0.25 * Math.sin(this.time * 9 + b.id);
      g.scale.setScalar(d * 0.012 * (facing - 0.93) * 14 * flick + 0.15);
    }
    for (; gi < this.glints.length; gi++) this.glints[gi].visible = false;
  }

  private alertBots(p: THREE.Vector3, radius: number, team: number) {
    for (const b of this.bots) if (b.alive && b.team !== team && b.position().distanceTo(p) < radius) b.hear(p);
  }

  private ejectCasing(req: ShotRequest, d: WeaponDef) {
    const ej = this.screenToWorld(req.ejectScreen, 0.6);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);
    const v = right.multiplyScalar(2.2 + Math.random()).addScaledVector(new THREE.Vector3(0, 1, 0), 1.6 + Math.random()).addScaledVector(back, 0.4).add(this.player.vel.clone().setY(0));
    this.fx.shell(ej, v, d.cls === 'Pistol' || d.cls === 'SMG' ? 'pistol' : d.cls === 'Sniper' || d.cls === 'Marksman' ? 'big' : d.cls === 'Shotgun' ? 'shotgun' : 'rifle');
  }

  // ---- environmental destruction (barrels, fences, cars)
  private setupDestruction() {
    this.destruction = new Destruction(this.scene, this.physics, this.fx, this.world.mats as Record<string, THREE.Material>, this.world.buildings.builder, this.world.infra.cars, {
      sound: (name, p, o = {}) => this.audio.play(name, { pos: p, gain: o.gain ?? 0.8, rate: o.rate, ref: o.ref ?? 4, reverb: 0.25, vary: 0.08 }),
      explode: (p, owner, r, dmg, kind) => {
        const def = kind === 'barrel' ? BARREL : VEHICLE;
        if (owner) this.explosives.explode(p, owner, def, r, dmg);
        else this.envBlast(p, r, dmg, def);
        if (kind === 'vehicle') {
          // the big one: a second, deeper boom and a longer shake
          const d = p.distanceTo(this.camera.position);
          this.audio.play('explosionFar', { pos: p, gain: 1.1, ref: 20, reverb: 0.8, delay: true, rate: 0.75, prio: 3 });
          if (d < 60) this.rig.addTrauma(0.4 * (1 - d / 60));
        }
      },
      burn: (p, r, dps, by, dt) => {
        for (const c of this.match.players) {
          if (!c.alive || c.position().distanceTo(p) > r + 0.4) continue;
          const amt = dps * dt;
          if (c === this.avatar) {
            this.hurtPlayer(amt, 'FIRE');
            if (Math.random() < dt * 4) {
              const to = p.clone().sub(this.player.pos);
              this.ui.damageFrom(Math.atan2(to.x, -to.z) + this.player.yaw);
              this.audio.play('hit', { gain: 0.25, rate: 0.6, bus: 'ui', reverb: 0 });
            }
          } else if (c instanceof Bot && !c.netPuppet) {
            c.health = Math.max(0, c.health - amt);
            c.onDamaged(by, amt, c.position().clone().sub(p).normalize());
            if (c.health <= 0) {
              c.alive = false;
              this.onKill(by && by.team !== c.team ? by : c, c, 'Fire', false, false);
            }
          }
        }
      },
      emitter: (key, buf, gain, p) => this.audio.emitter(key, buf, gain, p, { ref: 5, bus: 'sfx' }),
      stopEmitter: (key) => this.audio.stopEmitter(key),
      players: () => this.match.players,
    });
  }
  /** A blast nobody owns (a stray barrel / car): damages everyone, deaths count as accidents. */
  private envBlast(p: THREE.Vector3, r: number, dmg: number, def: WeaponDef) {
    this.fx.explosion(p, new THREE.Vector3(0, 1, 0), r / 8, 'asphalt');
    const d0 = p.distanceTo(this.camera.position);
    this.audio.play(d0 > 90 ? 'explosionFar' : 'explosion', { pos: p, gain: 1, ref: 14, reverb: 0.7, delay: true, prio: 3 });
    if (d0 < 45) this.rig.addTrauma(0.6 * (1 - d0 / 45));
    for (const c of this.match.players) {
      if (!c.alive) continue;
      const d = c.chest(new THREE.Vector3()).distanceTo(p);
      if (d > r || !this.physics.lineOfSight(p, c.chest(new THREE.Vector3()))) continue;
      const amt = dmg * (1 - Math.pow(d / r, 1.25));
      if (c === this.avatar) this.hurtPlayer(amt, def.name.toUpperCase());
      else if (c instanceof Bot && !c.netPuppet) {
        c.health = Math.max(0, c.health - amt);
        c.onDamaged(null, amt, c.position().clone().sub(p).normalize());
        if (c.health <= 0) {
          c.alive = false;
          this.onKill(c, c, def.name, false, false);
        }
      }
    }
    this.deployables.blast(p, r, this.avatar);
    this.destruction?.blast(p, r, null);
    this.alertBots(p, 70, -1);
  }

  /** Animation events of the Update 20 equipment: foley, camera weight and the actual deploys. */
  private equipEvent(name: string) {
    const fwd = new THREE.Vector3(-Math.sin(this.player.yaw), 0, -Math.cos(this.player.yaw));
    switch (name) {
      case 'legs': this.audio.play('legs', { gain: 0.6, reverb: 0, vary: 0.08 }); break;
      case 'stickyArm': this.audio.play('armChirp', { gain: 0.55, reverb: 0 }); this.audio.play('click', { gain: 0.4, reverb: 0, rate: 0.9 }); break;
      case 'c4Arm': this.audio.play('beep', { gain: 0.45, reverb: 0 }); this.audio.play('click', { gain: 0.45, reverb: 0, rate: 0.7 }); break;
      case 'twist': this.audio.play('click', { gain: 0.5, reverb: 0, rate: 0.75 + Math.random() * 0.1 }); break;
      case 'snapArm': this.audio.play('armChirp', { gain: 0.5, reverb: 0, rate: 0.8 }); break;
      case 'decoyTap': this.audio.play('click', { gain: 0.45, reverb: 0, rate: 1.3 }); this.audio.play('beep', { gain: 0.2, reverb: 0, rate: 1.6 }); break;
      case 'coverFlip': this.audio.play('click', { gain: 0.6, reverb: 0, rate: 0.6 }); break;
      case 'detonate': this.detonateMine(); break;
      case 'plantDip':
        // you drop to a knee to set it down
        this.rig.onSlideStart();
        this.audio.play('cloth', { gain: 0.6, reverb: 0 });
        break;
      case 'heavyLift':
        this.rig.onLand(5);
        this.audio.play('imp_metal_light', { gain: 0.35, rate: 0.7, reverb: 0 });
        this.audio.play('breathOut', { gain: 0.35, reverb: 0 });
        break;
      case 'shove':
        this.rig.onJump();
        this.audio.play('swish', { gain: 0.5, rate: 0.7, reverb: 0 });
        break;
      case 'plant': {
        this.rig.onLand(3);
        const at = this.groundAhead(0.85);
        const c = this.deployables.placeClaymore(this.avatar, at, this.player.yaw);
        this.equipNet?.('clay', { p: [c.pos.x, c.pos.y, c.pos.z], y: this.player.yaw, id: c.id });
        this.audio.play('imp_dirt', { pos: c.pos, gain: 0.5, ref: 2, reverb: 0.1 });
        this.audio.play('beep', { pos: c.pos, gain: 0.4, ref: 2, rate: 0.9, reverb: 0 });
        break;
      }
      case 'trophyOut': {
        const at = this.groundAhead(1.35);
        const t = this.deployables.deployTrophy(this.avatar, at, this.player.yaw);
        this.equipNet?.('trophy', { p: [t.pos.x, t.pos.y, t.pos.z], y: this.player.yaw, id: t.id });
        this.fieldCharge = 0;
        this.ui.notify('TROPHY SYSTEM', 'ACTIVE · 3 CHARGES');
        void fwd;
        break;
      }
    }
  }
  /** A spot on the ground in front of the player (pulled back from walls). */
  private groundAhead(dist: number) {
    const fwd = new THREE.Vector3(-Math.sin(this.player.yaw), 0, -Math.cos(this.player.yaw));
    const chest = this.player.pos.clone().setY(this.player.pos.y + 0.6);
    const wall = this.physics.raycast(chest, fwd, dist + 0.3);
    const d = wall ? Math.max(0.25, wall.distance - 0.3) : dist;
    return this.player.pos.clone().addScaledVector(fwd, d);
  }

  // ---- snapshot grenade: a scan pulse that outlines enemies through walls
  private pulses: { mesh: THREE.Mesh; t: number; p: THREE.Vector3 }[] = [];
  private pulseMat: THREE.ShaderMaterial | null = null;
  private snapshotPulse(p: THREE.Vector3, owner: Combatant) {
    const R = 22;
    this.audio.play('snapPulse', { pos: p, gain: 1, ref: 8, reverb: 0.4 });
    if (!this.pulseMat) {
      this.pulseMat = new THREE.ShaderMaterial({
        uniforms: { uT: { value: 0 }, uCol: { value: new THREE.Color(0.35, 0.75, 1.6) } },
        vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix*viewMatrix*w; }`,
        fragmentShader: `uniform float uT; uniform vec3 uCol; varying vec3 vN; varying vec3 vV; varying vec3 vW;
          void main(){ float f = 1.0 - abs(dot(vN, vV)); float rim = pow(f, 2.5);
            float scan = 0.5 + 0.5*sin(vW.y*9.0 - uT*40.0); float grid = step(0.92, fract(vW.y*2.0)) * 0.6;
            float a = (rim*0.9 + scan*0.08 + grid*rim) * (1.0 - uT); gl_FragColor = vec4(uCol*a, a); }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
    }
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.pulseMat.clone());
    mesh.position.copy(p);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.pulses.push({ mesh, t: 0, p: p.clone() });
    // the flash on the ground
    this.fx.sparks.spawn(p.clone().setY(p.y + 0.15), new THREE.Vector3(), [2, 4.5, 9], 1, 1.4, 0.12, { grow: 3 });
    for (let i = 0; i < 16; i++) this.fx.sparks.spawn(p, new THREE.Vector3((Math.random() - 0.5) * 5, Math.random() * 4, (Math.random() - 0.5) * 5), [1.5, 3.5, 7], 1, 0.03, 0.3, { drag: 0.7, grav: 9.8 });
    let n = 0;
    for (const c of this.match.players) {
      if (!c.alive || c.team === owner.team || c.position().distanceTo(p) > R) continue;
      this.revealed.set(c.id, this.time + 3.2);
      n++;
      if (c === this.avatar) {
        this.ui.announce('REVEALED', 'ENEMY SNAPSHOT GRENADE', 'bad');
        this.snapFlash(0.8);
      } else if (owner.team === this.avatar.team) this.spotted.set(c.id, Math.max(this.spotted.get(c.id) ?? 0, this.time + 3.2));
      // the owner's team knows where they are
      for (const m of this.bots) if (m.alive && m.team === owner.team && m.position().distanceTo(p) < 70) m.hear(c.position());
    }
    if (owner === this.avatar) {
      this.ui.notify('SNAPSHOT', n ? `${n} ENEMY${n > 1 ? 'IES' : ''} REVEALED` : 'NO CONTACTS');
      if (n) this.audio.play('uavPing', { gain: 0.35, bus: 'ui', reverb: 0, rate: 1.3 });
    }
    if (p.distanceTo(this.player.pos) < R && owner.team === this.avatar.team) this.snapFlash(0.45);
  }
  private snapFlashEl: HTMLElement | null = null;
  private snapFlash(k: number) {
    if (!this.snapFlashEl) {
      this.snapFlashEl = document.createElement('div');
      this.snapFlashEl.className = 'snapflash';
      this.ui.root.appendChild(this.snapFlashEl);
    }
    const el = this.snapFlashEl;
    el.style.setProperty('opacity', String(k));
    el.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.classList.remove('on');
      el.style.removeProperty('opacity');
    }));
  }

  // ---- decoy grenade: fake gunfire, fake radar contacts, bots fooled
  private decoyShot(d: Decoy) {
    const guns = ['k416', 'mp7', 'ks17', 'ums45', 'as20', 'lmg'] as const;
    const def = WEAPONS[guns[d.gun % guns.length]];
    const dist = d.p.distanceTo(this.camera.position);
    const occluded = dist > 4 && dist < 250 && !this.physics.lineOfSight(this.camera.position, d.p.clone().setY(d.p.y + 0.4));
    this.gunshot(def, d.p.clone().setY(d.p.y + 0.3), dist, occluded);
    // ...but no muzzle flash: just the speaker crackling (a tell if you are right on top of it)
    if (Math.random() < 0.3) this.fx.sparks.spawn(d.p.clone().setY(d.p.y + 0.1), new THREE.Vector3(0, 0.5, 0), [1, 0.6, 0.2], 0.6, 0.05, 0.05);
    this.noteGunfire(d.p);
    // the enemy team hears a fight there and goes to check it
    this.alertBots(d.p, 60, d.owner.team);
    // enemies see red contacts on their minimap, scattered around it
    if (d.owner.team !== this.avatar.team && d.burst === 0) {
      const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 6;
      this.fakePings.push({ x: d.p.x + Math.cos(a) * r, z: d.p.z + Math.sin(a) * r, t: this.time });
      if (this.fakePings.length > 12) this.fakePings.shift();
    }
  }

  private updateEquipFx(dt: number) {
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const pl = this.pulses[i];
      pl.t += dt / 1.1;
      const r = 22 * (1 - Math.pow(1 - Math.min(1, pl.t), 3));
      pl.mesh.scale.setScalar(Math.max(0.1, r));
      ((pl.mesh.material as THREE.ShaderMaterial).uniforms.uT.value = Math.min(1, pl.t));
      if (pl.t >= 1) {
        this.scene.remove(pl.mesh);
        pl.mesh.geometry.dispose();
        (pl.mesh.material as THREE.Material).dispose();
        this.pulses.splice(i, 1);
      }
    }
    // revealed enemies glow through walls for the snapshot's owner team
    for (const b of this.bots) {
      const until = this.revealed.get(b.id) ?? 0;
      const on = b.alive && b.team !== this.avatar.team && until > this.time;
      b.setReveal(on ? Math.min(1, (until - this.time) * 1.5) : 0);
    }
  }

  private weaponFoley(name: string, d: WeaponDef) {
    const map: Record<string, string> = {
      magOut: 'magOut', magIn: 'magIn', magTouch: 'magTouch', boltRelease: 'boltRelease', slideRelease: 'slideRelease',
      boltOpen: 'boltOpen', boltClose: 'boltClose', pumpBack: 'pumpBack', pumpForward: 'pumpForward', shellIn: 'shellIn',
      rattle: 'rattle', fireMode: 'click', draw: 'cloth', holster: 'cloth', inspect1: 'cloth', inspect2: 'rattle', reloadStart: 'cloth',
      adsIn: 'adsIn', adsOut: 'adsOut', lowAmmo: 'lowAmmo', breathIn: 'breathIn', breathOut: 'breathOut',
      boltBack: 'boltBack', slideBack: 'slideBack', dry: 'dry',
      // revolver
      cylOpen: 'cylOpen', cylClose: 'cylClose', cylFlipOpen: 'cylFlipOpen', cylFlipClose: 'cylFlipClose', ejectRod: 'eject', insert: 'insert', spin: 'spin', hammer: 'hammer',
    };
    const s = map[name];
    if (s) {
      // weapon actions play the gun's own field recording; missing actions borrow the closest
      // recorded action of the same gun (no synthesised weapon audio any more)
      const alias: Record<string, [string, number, number][]> = {
        magTouch: [['magIn', 0.32, 1.18], ['magOut', 0.3, 1.2]],
        boltClose: [['boltRelease', 0.9, 1], ['slideRelease', 0.9, 1], ['pumpForward', 0.7, 1.1]],
        boltOpen: [['boltBack', 0.7, 1.1], ['slideBack', 0.7, 1.1]],
        boltRelease: [['slideRelease', 0.9, 1], ['boltClose', 0.9, 1]],
        slideRelease: [['boltRelease', 0.9, 1.05]],
        boltBack: [['slideBack', 0.9, 1], ['boltOpen', 0.9, 1]],
        slideBack: [['boltBack', 0.9, 1]],
        rattle: [['magIn', 0.18, 1.4]],
        dry: [['dry', 0.8, 1]],
      };
      const weaponish = ['cylOpen', 'cylClose', 'cylFlipOpen', 'cylFlipClose', 'eject', 'insert', 'spin', 'hammer', 'magOut', 'magIn', 'magTouch', 'boltRelease', 'slideRelease', 'boltOpen', 'boltClose', 'pumpBack', 'pumpForward', 'shellIn', 'boltBack', 'slideBack', 'rattle', 'dry'];
      const rec = `${s}@${d.id}`;
      if (this.audio.has(rec)) this.audio.play(rec, { gain: 0.85, reverb: 0.06, vary: 0.035 });
      else if (weaponish.includes(s)) {
        const alt = (alias[s] ?? []).find(([k]) => this.audio.has(`${k}@${d.id}`));
        if (alt) this.audio.play(`${alt[0]}@${d.id}`, { gain: 0.85 * alt[1], rate: alt[2], reverb: 0.06, vary: 0.04 });
      } else if (this.audio.has(s)) this.audio.play(s, { gain: s === 'cloth' ? 0.45 : 0.8, reverb: 0.05, vary: 0.05 });
    }
    if (name === 'reloadStart') this.playerVoice('reload', 0.6);
    if (name === 'hullL' || name === 'hullR') {
      // the ejector throws the spent hull up and back past the shooter's shoulder
      const sc = this.vm.partCameraSpace(name === 'hullL' ? 'shellL' : 'shellR').project(this.vmCamera);
      const ej = this.screenToWorld(sc, 0.7);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);
      // (up and out to the right, only a little back: they arc away over the shoulder, never through the face)
      const v = back.multiplyScalar(0.5 + Math.random() * 0.4).addScaledVector(new THREE.Vector3(0, 1, 0), 2.4 + Math.random() * 0.8).addScaledVector(right, (name === 'hullR' ? 1.6 : 1.1) + Math.random() * 0.5).add(this.player.vel.clone().setY(0));
      this.fx.shell(ej, v, 'shotgun');
      if (this.audio.has(`shellIn@${d.id}`)) this.audio.play(`shellIn@${d.id}`, { gain: 0.28, rate: 1.6, reverb: 0.04, vary: 0.06 });
    }
    if (name === 'nvgGrab') this.audio.play('click', { gain: 0.35, reverb: 0, rate: 0.7 });
    if (name === 'nvgDown') {
      this.nvg.engage();
      this.audio.play(this.audio.has('nvgOn') ? 'nvgOn' : 'click', { gain: 0.75, bus: 'ui', reverb: 0 });
      this.playerVoice('nvg', 0.35);
    }
    if (name === 'nvgUp') {
      this.nvg.disengage();
      this.audio.play(this.audio.has('nvgOff') ? 'nvgOff' : 'click', { gain: 0.7, bus: 'ui', reverb: 0 });
    }
    if (name === 'pin') {
      if (this.throwKind === 'frag') this.cookStart = this.time;
      this.audio.play('pin', { gain: 0.6, reverb: 0.03 });
    }
    if (name === 'stimCap') this.audio.play('click', { gain: 0.5, reverb: 0, rate: 0.8 });
    if (name === 'stockOut') {
      this.audio.play('bipod', { gain: 0.42, rate: 1.75, reverb: 0 });
      this.audio.play('click', { gain: 0.5, rate: 0.9, reverb: 0 });
    }
    if (name === 'stockIn') this.audio.play('legs', { gain: 0.35, rate: 1.2, reverb: 0 });
    this.equipEvent(name);
    if (name === 'stimInject') {
      this.audio.play('stimInject', { gain: 0.9, reverb: 0.03 });
      this.audio.play('stimHiss', { gain: 0.6, reverb: 0 });
      this.audio.play('breathIn', { gain: 0.6, reverb: 0, rate: 0.9 });
      this.stimT = 10;
      this.playerVoice('stim');
      this.rig.addTrauma(0.15);
      this.ui.announce('STIM', 'HEALTH + SPEED BOOST 10 s', 'good');
    }
    if (name === 'uavPress') {
      if (this.streaks.use(this.avatar, 'uav', this.time)) this.audio.play('uavPing', { gain: 0.5, bus: 'ui', reverb: 0 });
    }
    if (name === 'laserOn') this.audio.play('click', { gain: 0.5, reverb: 0, rate: 1.6 });
    if (name === 'release') {
      this.throwPlayerGrenade();
      if (this.throwKind !== 'tknife') this.playerVoice(this.throwKind, 0.9);
    }
    if (name === 'swish') this.audio.play('swish', { gain: 0.55, reverb: 0.03, vary: 0.08 });
    if (name === 'meleeHit') this.meleeHit();
    if (name === 'kHit') this.knifeHit();
    if (name === 'knifeSwing') this.meleeHit(200, 'Combat Knife', 2.4);
    if (name === 'eject6') {
      // six cases tumble out of the cylinder
      const ej = this.screenToWorld(this.vm.socketCameraSpace('eject').project(this.vmCamera), 0.55);
      const down = new THREE.Vector3(0, -1, 0);
      const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);
      for (let i = 0; i < 6; i++) {
        const v = down.clone().multiplyScalar(0.6 + Math.random() * 0.8).addScaledVector(back, 0.3 + Math.random() * 0.4).add(new THREE.Vector3((Math.random() - 0.5) * 0.8, 0, (Math.random() - 0.5) * 0.8)).add(this.player.vel.clone().multiplyScalar(0.8));
        this.fx.shell(ej.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.02, (Math.random() - 0.5) * 0.02, (Math.random() - 0.5) * 0.02)), v, 'pistol');
      }
    }
    // (spent magazines and the empty speedloader simply vanish as they leave the hand — no world
    // debris: spawning them into the world scene was the source of the empty-reload crashes)
    if (name === 'magTap' && this.audio.has(`magIn@${d.id}`)) this.audio.play(`magIn@${d.id}`, { gain: 0.4, rate: 1.25, reverb: 0.05 });
    if (name === 'eject') {
      const ej = this.screenToWorld(this.vm.socketCameraSpace('eject').project(this.vmCamera), 0.6);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      this.fx.shell(ej, right.multiplyScalar(1.8).add(new THREE.Vector3(0, 1.8, 0)), d.cls === 'Shotgun' ? 'shotgun' : 'big');
    }
  }

  footstepSound(p: THREE.Vector3, speed: number, local: boolean) {
    // remote footsteps fall off with ref 3 m: past ~40 m they're inaudible under the mix, so skip
    // the ground probe and the 3–5 audio nodes (24 soldiers × ~2 steps/s)
    if (!local && p.distanceToSquared(this.camera.position) > 40 * 40) return;
    const hit = this.physics.raycast(new THREE.Vector3(p.x, p.y + 0.3, p.z), new THREE.Vector3(0, -1, 0), 1.2);
    let s: string = hit ? hit.info.surface : 'grass';
    if (hit && hit.info.tag === 'terrain') s = this.terrain.surfaceAt(p.x, p.z);
    const name = s === 'snow' ? 'step_snow' : s === 'woodFloor' ? 'step_floor' : s === 'wood' ? 'step_wood' : s === 'metal' ? 'step_metal' : s === 'water' ? 'step_water' : s === 'gravel' ? 'step_gravel' : s === 'grass' ? 'step_grass' : s === 'dirt' || s === 'sand' ? 'step_dirt' : 'step_concrete';
    // interior floorboards: dull and boxy; outdoor decks: hollow with a plank knock and more air
    const rate = name === 'step_floor' ? 0.86 : name === 'step_dirt' ? 0.8 : 1;
    const lowpass = name === 'step_floor' ? 2600 : name === 'step_dirt' ? 3000 : undefined;
    const g = (local ? 0.22 + speed * 0.4 : 0.35 + speed * 0.5) * (name === 'step_grass' || name === 'step_dirt' ? 1.3 : 1);
    if (local) {
      // weight and pace: heavier/brighter when sprinting, soft heel-roll when crouched or walking
      const pl = this.player;
      const pace = pl.tactical ? 1.12 : pl.sprinting ? 1.05 : pl.stance === 'crouch' ? 0.92 : 1;
      this.audio.play(name, { gain: g * (pl.stance === 'crouch' ? 0.55 : 1), reverb: name === 'step_floor' ? 0.25 : 0.06, vary: 0.09, rate: rate * pace, lowpass });
      // gear: sling/kit rattle on hard running, cloth swish otherwise
      if (pl.sprinting && Math.random() < (pl.tactical ? 0.8 : 0.45)) this.audio.play('imp_metal_light', { gain: 0.05 + speed * 0.04, rate: 1.6 + Math.random() * 0.5, reverb: 0.02, vary: 0.1, bus: 'sfx' });
      if (speed > 0.3 && Math.random() < 0.4) this.audio.play('cloth', { gain: 0.08 + speed * 0.08, rate: 1.1, reverb: 0, vary: 0.15 });
    }
    else {
      // occlusion: what is between you and them? A door or a thin wooden / glass wall takes the
      // top off (you still hear the scuff), masonry, rock and earth leave a dull thud, two layers
      // or more barely a knock. Nearby open gaps are approximated by also testing a ray from
      // slightly to the side — if either path is open the step reaches you clearly.
      const occ = this.footOcclusion(p);
      const lp = occ.lp ? Math.min(occ.lp, lowpass ?? 20000) : lowpass;
      this.audio.play(name, { pos: p, gain: g * occ.gain, ref: 3, reverb: 0.12 + occ.verb, vary: 0.1, rate, lowpass: lp });
      if (occ.layers === 0 && name === 'step_wood' && Math.random() < 0.35) this.audio.play('imp_plank', { pos: p, gain: 0.15, ref: 2, rate: 0.7 });
      if (occ.layers === 0 && name === 'step_gravel') this.audio.play('step_concrete', { pos: p, gain: g * 0.35, ref: 3, rate: 1.2 });
      return;
    }
    if (name === 'step_wood' && Math.random() < 0.35) this.audio.play('imp_plank', { gain: 0.12, rate: 0.7, reverb: 0.1 });
    if (name === 'step_gravel') this.audio.play('step_concrete', { gain: g * 0.35, rate: 1.2, reverb: 0.02 });
  }

  // ---------------------------------------------------------------- ambience: the wider war, tunnel wind
  private battleT = 4;
  private ambT = 0;
  /**
   * Distant battle: somewhere beyond the fjord another fight is going on. Every few seconds a
   * burst of rifle or machine-gun fire, the odd single sniper shot, an explosion or an artillery
   * rumble plays from a random bearing 300–900 m out, low-passed by distance and panned to where
   * it came from; quieter indoors and in the tunnel, silent in menus.
   *
   * Tunnel shafts: each emergency shaft and both portals carry a looping wind emitter. The draught
   * gusts (gain, filter and pitch move together), each shaft has its own voice, and because they
   * are real positional sources the howl swells as you climb toward a hatch and fades down the
   * gallery.
   */
  private worldAmbience(dt: number) {
    this.ambT += dt;
    const cam = this.camera.position;
    const playing = this.state === 'playing' || this.state === 'ended';
    if (playing) {
      this.battleT -= dt;
      if (this.battleT <= 0) {
        this.battleT = 1.8 + Math.random() * 5.5;
        const a = Math.random() * Math.PI * 2;
        const d = 300 + Math.random() * 600;
        const pos = new THREE.Vector3(cam.x + Math.cos(a) * d, cam.y + 20 + Math.random() * 40, cam.z + Math.sin(a) * d);
        const shelter = 1 - 0.55 * this.audio.indoor;
        const lp = 1600 - (d - 300) * 1.4;
        const base = { pos, ref: d, reverb: 0.6, bus: 'amb' as const, lowpass: Math.max(450, lp), prio: 0 };
        const r = Math.random();
        if (r < 0.62) {
          // a burst: rifle or LMG, 3–14 rounds, sometimes answered
          const guns = ['k416', 'ks17', 'lmg', 'lmg', 'mp7', 'ums45'];
          const id = guns[Math.floor(Math.random() * guns.length)];
          const key = this.audio.has(`far_${id}`) ? `far_${id}` : this.audio.has(`shot_${id}`) ? `shot_${id}` : null;
          if (key) {
            const n = 3 + Math.floor(Math.random() * (id === 'lmg' ? 12 : 7));
            const gap = 60 / WEAPONS[id as keyof typeof WEAPONS].rpm;
            for (let i = 0; i < n; i++) this.audio.play(key, { ...base, gain: (0.07 + Math.random() * 0.05) * shelter, at: i * gap * (1 + Math.random() * 0.15), vary: 0.05 });
            if (Math.random() < 0.4) {
              const p2 = pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 120, 0, (Math.random() - 0.5) * 120));
              for (let i = 0; i < 4; i++) this.audio.play(key, { ...base, pos: p2, gain: 0.05 * shelter, at: 0.9 + i * gap * 1.4, vary: 0.06 });
            }
          }
        } else if (r < 0.8) {
          this.audio.play('explosionFar', { ...base, gain: (0.18 + Math.random() * 0.12) * shelter, lowpass: Math.max(300, lp * 0.5), vary: 0.1 });
        } else if (r < 0.9) {
          this.audio.play(this.audio.has('far_skv338') ? 'far_skv338' : 'explosionFar', { ...base, gain: 0.08 * shelter, vary: 0.04 });
        } else {
          // artillery: a few rolling thumps
          for (let i = 0; i < 3; i++) this.audio.play('explosionFar', { ...base, gain: 0.12 * shelter, lowpass: 280, rate: 0.7, at: i * (0.5 + Math.random() * 0.6), vary: 0.08 });
        }
      }
    }
    // ---- tunnel draughts
    const shafts = tunnelShafts();
    const W = TUNNEL.width / 2;
    const inTunnel = Math.abs(cam.x - TUNNEL.x) < W + TUNNEL_EXIT.gx1 + 1 && cam.z > TUNNEL.z0 - 4 && cam.z < TUNNEL.z1 + 4 && cam.y < TUNNEL_EXIT.floor + TUNNEL.height + 2;
    const near = Math.abs(cam.z - (TUNNEL.z0 + TUNNEL.z1) / 2) < 70 && Math.abs(cam.x - TUNNEL.x) < 70;
    shafts.forEach((sh, i) => {
      const t = this.ambT * (0.23 + i * 0.07) + i * 3.1;
      const gust = 0.55 + 0.25 * Math.sin(t) + 0.2 * Math.sin(t * 2.7 + 1.3) * Math.sin(t * 0.41);
      const pos = new THREE.Vector3((sh.x0 + sh.x1) / 2, (TUNNEL_EXIT.floor + sh.top) / 2, (sh.z0 + sh.z1) / 2);
      this.audio.emitter(`shaft${i}`, 'loop_wind', near ? (inTunnel ? 1.1 : 0.45) * gust : 0, pos, { ref: 3.5, lowpass: 500 + 1800 * gust, rate: (i ? 1.18 : 0.92) + 0.12 * gust });
    });
    for (const [i, z] of [TUNNEL.z0, TUNNEL.z1].entries()) {
      const t = this.ambT * 0.17 + i * 5;
      const gust = 0.6 + 0.4 * Math.sin(t) * Math.sin(t * 1.9 + 0.7);
      this.audio.emitter(`portal${i}`, 'loop_wind', near ? (inTunnel ? 0.9 : 0.35) * gust : 0, new THREE.Vector3(TUNNEL.x, TUNNEL_EXIT.floor + 3, z), { ref: 6, lowpass: 320 + 500 * gust, rate: 0.62 + 0.08 * gust });
    }
  }

  private occA = new THREE.Vector3();
  private occB = new THREE.Vector3();
  private occD = new THREE.Vector3();
  /** Sound occlusion between the listener and a point near the ground (footsteps, foley). */
  footOcclusion(p: THREE.Vector3) {
    const cam = this.camera.position;
    const src = this.occB.set(p.x, p.y + 0.35, p.z);
    const dist = src.distanceTo(cam);
    if (dist < 1.5) return { gain: 1, lp: 0, verb: 0, layers: 0 };
    const dir = this.occD.copy(src).sub(cam).divideScalar(dist);
    let layers = 0, thin = true, travelled = 0;
    const from = this.occA.copy(cam);
    for (let i = 0; i < 3 && travelled < dist - 0.2; i++) {
      const hit = this.physics.raycast(from, dir, dist - travelled - 0.1);
      if (!hit) break;
      layers++;
      const tag = hit.info.tag;
      const sf = hit.info.surface;
      if (!(tag === 'door' || sf === 'wood' || sf === 'woodFloor' || sf === 'glass' || sf === 'fabric' || sf === 'metal')) thin = false;
      travelled += hit.distance + 0.35;
      from.copy(hit.point).addScaledVector(dir, 0.35);
    }
    if (layers === 0) return { gain: 1, lp: 0, verb: 0, layers };
    // a side path (round a corner, through a doorway next to them) softens a blocked line
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(0.9);
    const alt = this.physics.lineOfSight(cam.clone().add(side), src.clone().add(side)) || this.physics.lineOfSight(cam.clone().sub(side), src.clone().sub(side));
    if (alt) return { gain: 0.8, lp: 3800, verb: 0.08, layers: 1 };
    if (layers === 1 && thin) return { gain: 0.62, lp: 1500, verb: 0.12, layers };
    if (layers === 1) return { gain: 0.42, lp: 650, verb: 0.18, layers };
    return { gain: 0.22, lp: 420, verb: 0.2, layers };
  }

  /** Environmental damage (falls, out of bounds). */
  private hurtPlayer(amount: number, cause: string) {
    const a = this.avatar;
    if (!a.alive) return;
    a.health = Math.max(0, a.health - amount);
    a.lastHitT = 0;
    if (a.health <= 0) {
      a.alive = false;
      this.onKill(a, a, cause, false, false);
      this.killerName = cause.toUpperCase();
      this.killerWeapon = '';
    }
  }

  /** Hit feedback in the world: blood sprays onto the wall / floor behind the target. */
  private bloodSpatter(v: Combatant, part: HitPart, dir: THREE.Vector3, amt: number) {
    if (v.isPlayer) return;
    const at = v.chest(new THREE.Vector3());
    if (part === 'head') at.y += 0.42;
    else if (part === 'limb') at.y -= 0.45;
    const hit = this.physics.raycast(at, dir, 2.6);
    if (hit) this.fx.decal(hit.point, hit.normal, 'flesh', 0.25 + Math.min(0.4, amt / 120) * (part === 'head' ? 1.4 : 1));
    if (v.health <= 0) {
      // a pool where they drop
      const down = this.physics.raycast(at, new THREE.Vector3(0, -1, 0), 3);
      if (down) this.fx.decal(down.point, down.normal, 'flesh', 0.7 + Math.random() * 0.3);
    }
  }

  /** First-person legs: a lower-body soldier under the camera, a little behind the eye so the
   *  camera never sits inside it; hidden whenever the body would need poses it does not have. */
  private updateLegs(dt: number) {
    const pl = this.player;
    // (only posed when you can see them: looking down; it's a whole skinned soldier)
    const show = this.avatar.alive && !this.killcam && pl.stance === 'stand' && !pl.sliding && !pl.diving && !pl.mantle && !pl.ladder && pl.pitch < -0.32;
    this.legs.root.visible = show;
    if (!show) return;
    const s = this.legsBuf;
    const back = 0.14;
    s[0] = pl.pos.x + Math.sin(pl.yaw) * back;
    s[1] = pl.pos.y;
    s[2] = pl.pos.z + Math.cos(pl.yaw) * back;
    const hv = Math.hypot(pl.vel.x, pl.vel.z);
    // legs face the direction of travel when moving (within reason), the view otherwise
    let yaw = pl.yaw;
    if (hv > 1) {
      const mv = Math.atan2(-pl.vel.x, -pl.vel.z);
      let d = mv - pl.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) < 1.2) yaw = pl.yaw + d * 0.8;
      else if (Math.abs(d) > 2.2) yaw = pl.yaw + (d - Math.sign(d) * Math.PI) * 0.6; // backpedal
    }
    this.playerPose(s);
    s[0] = pl.pos.x + Math.sin(pl.yaw) * back;
    s[2] = pl.pos.z + Math.cos(pl.yaw) * back;
    s[3] = pl.yaw; s[4] = pl.yaw; s[5] = 0; s[14] = 0; s[13] = 0;
    void yaw;
    this.legs.puppet(s, dt);
  }

  /** A supply pouch: health, a magazine for both weapons, a frag and a tactical (capped). */
  private collectSupplies() {
    const a = this.avatar;
    const got: string[] = [];
    if (a.health < 100) {
      a.health = Math.min(100, a.health + 40);
      got.push('+HEALTH');
    }
    let ammo = false;
    for (const sl of this.weapons.slots) {
      const cap = sl.def.reserve * 1.5;
      if (sl.reserve < cap) {
        sl.reserve = Math.min(cap, sl.reserve + sl.def.mag);
        ammo = true;
      }
    }
    if (ammo) got.push('+AMMO');
    const lmax = LETHAL_COUNT[this.loadout.lethal] ?? 2;
    if (this.frags < lmax) {
      this.frags++;
      got.push('+' + (LETHALS.find((l) => l.id === this.loadout.lethal)?.name ?? 'LETHAL'));
    }
    const tmax = TACTICAL_COUNT[this.loadout.tactical];
    if (this.tacCount < tmax) {
      this.tacCount++;
      got.push('+' + this.loadout.tactical.toUpperCase());
    }
    this.ui.notify('SUPPLIES', got.join('  ') || 'FULL');
    this.audio.play(this.audio.has(`magIn@${this.weapons.cur.def.id}`) ? `magIn@${this.weapons.cur.def.id}` : 'click', { gain: 0.5, reverb: 0.05, rate: 1.1 });
    this.audio.play('cloth', { gain: 0.6, reverb: 0 });
    this.playerVoice('supply', 0.4);
  }

  /** Flash / stun / stim on the player. */
  private updateStatusEffects(dt: number) {
    const a = this.avatar;
    if (!a.alive) {
      this.blindT = this.stunT = this.stimT = 0;
    }
    this.blindT = Math.max(0, this.blindT - dt);
    this.stunT = Math.max(0, this.stunT - dt);
    this.stimT = Math.max(0, this.stimT - dt);
    if (this.blindT > 0) this.flashFx = Math.max(this.flashFx, this.blindK * Math.min(1, this.blindT / 0.9));
    else this.blindK = 0;
    let sp = 1;
    if (this.stunT > 0) {
      sp *= 0.45;
      this.rig.addTrauma(dt * 0.35);
    }
    if (this.stimT > 0) {
      sp *= 1.18;
      a.health = Math.min(100, a.health + dt * (this.stimT > 9.3 ? 90 : 14));
    }
    this.player.statusSpeedMul = sp;
    this.ui.updateStatus(this.stimT, this.stunT, this.blindT);
  }

  private heartT = 0;
  private wasLow = false;
  /** Damage feedback for the player: heartbeat and heavy breathing at low health. */
  private damageFeedback(dt: number) {
    const a = this.avatar;
    const low = a.alive && a.health < 40;
    if (low) {
      this.heartT -= dt;
      if (this.heartT <= 0) {
        const k = 1 - a.health / 40;
        this.heartT = 1.15 - 0.45 * k;
        this.audio.play('heartbeat', { gain: 0.35 + 0.45 * k, bus: 'ui', reverb: 0 });
      }
    }
    if (this.wasLow && !low && a.alive) this.audio.play('breathOut', { gain: 0.5, reverb: 0 });
    this.wasLow = low;
  }

  private onPlayerHurt(from: Combatant | null, amt: number) {
    this.rig.addTrauma(Math.min(0.5, amt / 60));
    // flinch: the view is knocked away from the shooter
    let side = (Math.random() - 0.5) * 2;
    if (from) {
      const to = from.position().clone().sub(this.player.pos);
      const right = new THREE.Vector3(Math.cos(this.player.yaw), 0, -Math.sin(this.player.yaw));
      side = -Math.sign(to.dot(right)) || side;
    }
    if (amt > 25) this.playerVoice('hurt', 0.3);
    const k = Math.min(1.5, amt / 30);
    this.rig.shotKick({ pitch: 0.012 * k, yaw: 0.01 * side * k, roll: 0.03 * side * k, back: 0.012 * k, fov: 0.004 * k });
    // real (small) aim punch and the gun knocked in your hands: getting shot costs you the fight
    this.player.addRecoil(0.006 * k * (Math.random() * 0.6 + 0.7), 0.004 * side * k);
    this.vm.jolt(-0.8 * k, side * 0.9 * k, 0.3 * k);
    if (amt > 40) this.audio.play('imp_punch', { gain: 0.35, reverb: 0, rate: 0.7 });
    this.flashFx = Math.min(0.25, this.flashFx + amt / 300);
    if (from) {
      const to = from.position().clone().sub(this.player.pos);
      const world = Math.atan2(to.x, -to.z);
      this.ui.damageFrom(world + this.player.yaw);
    }
    this.audio.play('imp_flesh', { gain: 0.7, reverb: 0 });
  }

  /**
   * Death cry: ten different takes, never one of the last few again, pitched per soldier so the
   * same take still sounds like a different man. Headshots are mostly silent (or a short grunt).
   */
  private screamHist: number[] = [];
  private deathScream(victim: Combatant, headshot: boolean) {
    const n = this.audio.bank.scream?.length ?? 0;
    if (!n) return;
    if (headshot && Math.random() < 0.55) return;
    const short = [2, 4, 9].filter((i) => i < n);
    const pool = (headshot && short.length ? short : Array.from({ length: n }, (_, i) => i)).filter((i) => !this.screamHist.includes(i));
    const v = pool.length ? pool[Math.floor(Math.random() * pool.length)] : Math.floor(Math.random() * n);
    this.screamHist.push(v);
    while (this.screamHist.length > Math.min(5, n - 2)) this.screamHist.shift();
    const rate = 0.9 + ((victim.id * 13) % 9) * 0.025;
    if (victim === this.avatar) {
      this.audio.play('scream', { variant: v, gain: 0.75, bus: 'ui', reverb: 0.08, rate, vary: 0.02, prio: 3, lowpass: 9000 });
      return;
    }
    const p = victim.eye(new THREE.Vector3());
    const d = p.distanceTo(this.camera.position);
    const occl = d > 5 && !this.physics.lineOfSight(this.camera.position, p);
    this.audio.play('scream', { pos: p, variant: v, gain: occl ? 0.8 : 1.15, ref: 4.5, maxDist: 75, reverb: occl ? 0.5 : 0.3, rate, vary: 0.03, prio: 2, lowpass: occl ? 1400 : undefined });
  }

  private onKill(killer: Combatant, victim: Combatant, weapon: string, headshot: boolean, wallbang: boolean) {
    // online: a soldier owned by another machine only dies when its owner says so
    if (NETF.active && victim instanceof Bot && victim.netPuppet && !NETF.allowPuppetDeath) return;
    this.netg?.reportDeath(killer, victim, weapon, headshot, wallbang);
    this.match.registerKill(killer, victim, weapon, headshot, wallbang, this.time);
    this.streaks.onKill(killer, victim, weapon === MORTAR.name || weapon === HELI.name);
    if (killer instanceof Bot && killer !== victim && Math.random() < 0.5) this.botVoice(killer, 'kill');
    else if (victim !== this.avatar) {
      const mate = this.bots.find((b) => b.alive && b !== victim && b.team === victim.team && b.position().distanceTo(victim.position()) < 30);
      if (mate && Math.random() < 0.6) this.botVoice(mate, 'mandown');
    }
    this.match.spawns?.noteDeath(victim.position(), victim.team);
    this.deathScream(victim, headshot);
    if (victim instanceof Bot) {
      victim.kill(victim.position().clone().sub(killer.position()).normalize());
      // enemies drop a supply pouch
      if (victim.team !== this.avatar.team) {
        const vp = victim.position();
        this.pickups.drop(vp, this.groundHeightAt(vp.x, vp.z));
      }
    }
    if (victim === this.avatar) {
      this.player.dead = true;
      this.weapons.enabled = false;
      this.deathTime = this.time;
      this.killcamSlot = killer instanceof Bot ? this.bots.indexOf(killer) : -1;
      this.respawnT = this.killcamSlot >= 0 ? 1.7 : 3.5;
      this.killerName = killer.name.toUpperCase();
      this.killerWeapon = weapon.toUpperCase();
      this.deathCamTarget = killer !== victim ? killer.position().clone() : null;
      this.vm.root.visible = false;
    }
    if (killer === this.avatar && victim !== this.avatar) this.playerKillJuice(victim, weapon, headshot, wallbang);
    if (victim === this.avatar) this.killStreak = 0;
    if (victim === this.avatar && killer !== victim) {
      this.lastKiller = killer;
      this.deathStreak++;
    }
  }

  private lastKiller: Combatant | null = null;
  private multiT = -99;
  private multiN = 0;
  private deathStreak = 0;
  private firstBlood = true;

  /** Kill feedback: red hitmarker, layered confirm sounds, and a small "+XP / reasons" text by the crosshair. */
  private playerKillJuice(victim: Combatant, weapon: string, headshot: boolean, wallbang: boolean) {
    const dist = victim.position().distanceTo(this.player.pos);
    this.ui.hitmarker(true, headshot, 100);
    this.audio.play(headshot ? 'killHead' : 'kill', { gain: 0.95, bus: 'ui', reverb: 0.02, vary: 0.015, prio: 3 });
    this.rig.killPunch(headshot ? 1.1 : 0.8);
    const vdir = victim.position().clone().sub(this.player.pos).setY(0).normalize();
    this.fx.killBurst(victim.chest(new THREE.Vector3()), vdir, headshot, victim.position().y);
    const reasons: string[] = [];
    let pts = 100;
    let bonus = 0;
    const add = (label: string, p: number, matchCounted = false) => {
      reasons.push(label);
      pts += p;
      if (!matchCounted) bonus += p;
    };
    if (headshot) add('HEADSHOT', 50, true);
    if (wallbang) add('WALLBANG', 25, true);
    const sniper = weapon.includes('.338');
    if (dist > (sniper ? 90 : 55)) add('LONGSHOT', 50);
    if (dist < 3) add('POINT BLANK', 25);
    // Domination: kills on or near a flag
    for (const f of this.dom.flags) {
      const near = (p: THREE.Vector3) => Math.hypot(p.x - f.pos.x, p.z - f.pos.z) < f.radius + 10;
      if (!near(victim.position()) && !near(this.player.pos)) continue;
      if (f.owner === this.avatar.team) add('DEFENSE', 50);
      else add('OFFENSE', 50);
      break;
    }
    if (this.lastKiller && victim === this.lastKiller) {
      add('REVENGE', 50);
      this.lastKiller = null;
    }
    if (this.deathStreak >= 4) add('COMEBACK', 50);
    this.deathStreak = 0;
    if (this.firstBlood) {
      add('FIRST BLOOD', 50);
      this.firstBlood = false;
    }
    this.killStreak++;
    if (this.killStreak === 5) add('MERCILESS', 75);
    else if (this.killStreak === 10) add('RUTHLESS', 100);
    // multi kills within 4 seconds
    if (this.time - this.multiT < 4) this.multiN++;
    else this.multiN = 1;
    this.multiT = this.time;
    const multi = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'FURY KILL', 'FRENZY KILL', 'SUPER KILL'][Math.min(this.multiN, 6)];
    if (multi) add(multi, 50 * (this.multiN - 1));
    this.avatar.score += bonus;
    this.ui.killText(pts, reasons);
    if (this.multiN >= 2) this.playerVoice('multi', 0.8);
    else if (headshot) this.playerVoice('headshot', 0.45);
    else this.playerVoice('kill', 0.35);
  }
  private killStreak = 0;

  // ================================================================ debug helpers (automation)
  view(x: number, z: number, yaw: number, pitch = 0, y?: number) {
    if (this.state !== 'playing') {
      this.state = 'playing';
      this.ui.showMenu(false);
      this.ui.showHUD(true);
    }
    const gy = y ?? this.terrain.heightAt(x, z) + 0.1;
    this.player.teleport(new THREE.Vector3(x, gy, z), yaw);
    this.player.pitch = pitch;
    return this.step(2);
  }

  async grid(views: [number, number, number, number, number?][], cols = 2) {
    const w = this.canvas.width, h = this.canvas.height;
    const out = document.createElement('canvas');
    const rows = Math.ceil(views.length / cols);
    out.width = (w / 2) * cols;
    out.height = (h / 2) * rows;
    const ctx = out.getContext('2d')!;
    for (let i = 0; i < views.length; i++) {
      const [x, z, yaw, pitch, y] = views[i];
      this.player.frozen = y !== undefined;
      this.view(x, z, yaw, pitch, y);
      this.step(35);
      ctx.drawImage(this.canvas, (i % cols) * (w / 2), Math.floor(i / cols) * (h / 2), w / 2, h / 2);
    }
    return out.toDataURL('image/jpeg', 0.85);
  }

  debugVM(yaw = 1.57, pitch = 0.2, dist = 0.9, cx = 0.05, cy = -0.12, cz = -0.25) {
    const cam = new THREE.PerspectiveCamera(35, this.camera.aspect, 0.01, 10);
    const c = new THREE.Vector3(cx, cy, cz);
    cam.position.set(c.x + Math.sin(yaw) * Math.cos(pitch) * dist, c.y + Math.sin(pitch) * dist, c.z + Math.cos(yaw) * Math.cos(pitch) * dist);
    cam.lookAt(c);
    const bg = this.vmScene.background;
    this.vmScene.background = new THREE.Color(0x40454a);
    this.renderer.setRenderTarget(null);
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.render(this.vmScene, cam);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.vmScene.background = bg;
  }

  inspectModel(id: WeaponId, yaw = 1.2, dist = 0.9, pitch = 0.15) {
    const sc = new THREE.Scene();
    sc.background = new THREE.Color(0x3a3d40);
    sc.environment = this.vmScene.environment;
    const m = WEAPON_BUILDERS[id](this.wmats);
    sc.add(m.root);
    const box = new THREE.Box3().setFromObject(m.root);
    const c = box.getCenter(new THREE.Vector3());
    const l = new THREE.DirectionalLight(0xffffff, 2.5);
    l.position.set(1, 2, 1.5);
    sc.add(l, new THREE.AmbientLight(0xffffff, 0.3));
    const cam = new THREE.PerspectiveCamera(30, this.camera.aspect, 0.01, 10);
    cam.position.set(c.x + Math.sin(yaw) * dist * Math.cos(pitch), c.y + Math.sin(pitch) * dist, c.z + Math.cos(yaw) * dist * Math.cos(pitch));
    cam.lookAt(c);
    this.renderer.setRenderTarget(null);
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.render(sc, cam);
    this.renderer.toneMapping = THREE.NoToneMapping;
  }
}
