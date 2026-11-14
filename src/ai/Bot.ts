import { inTunnel } from '../world/MapLayout';
import * as THREE from 'three';
import { NETF } from '../net/NetFlags';
import { bakeFlat, bakeProxy } from '../render/Batch';
import { Soldier } from '../character/Soldier';
import { roleFor, SoldierLook } from '../character/SoldierMesh';
import { AnimState, ActionKind, newAnimState, ReloadStyle, heldCode } from '../character/SoldierAnim';
import { CharacterBody } from '../player/CharacterBody';
import { Physics } from '../core/Physics';
import { NavGraph, NavNode } from './NavGraph';
import { WeaponDef, WEAPONS } from '../weapons/WeaponDefs';
import { WeaponModel } from '../weapons/WeaponModels';
import { clamp, damp, dampAngle, lerp, RNG, wrapAngle, easeOutCubic, Spring } from '../core/math';
import { Combatant, HitPart } from '../game/Combatant';
import { Ragdoll } from './Ragdoll';
import { AimController, CoverMap, detectRate, Exposure, Order, SKILL } from './BotBrain';

/** replicated / recorded pose: see Bot.replayState */
export const POSE_N = 20;
const ACTIONS: ActionKind[] = ['none', 'reload', 'throw', 'melee', 'knife', 'switch', 'bolt', 'plant', 'throwL', 'stim', 'detonate', 'place'];
export function actionCode(a: ActionKind) {
  return Math.max(0, ACTIONS.indexOf(a));
}
export function reloadStyleFor(def: WeaponDef): ReloadStyle {
  const id = def.id;
  if (id === 'db12') return 'break';
  if (id === 'pump12' || id === 'as20') return 'shell';
  if (id === 'skv338' || id === 'kr98') return 'bolt';
  if (id === 'lmg') return 'box';
  if (id === 'rv357') return 'rev';
  if (def.cls === 'Pistol') return 'pistol';
  return 'mag';
}

export interface BotWorld {
  physics: Physics;
  nav: NavGraph;
  combatants: () => Combatant[];
  fire(shooter: Combatant, origin: THREE.Vector3, dir: THREE.Vector3, def: WeaponDef, muzzle: THREE.Vector3): void;
  footstep(pos: THREE.Vector3, speed: number, c: Combatant): void;
  objectiveFor(team: 0 | 1, from: THREE.Vector3, bot?: Bot): THREE.Vector3;
  /** per-bot A* options (route variety / squad spreading) */
  pathOpts?(bot: Bot): { noise?: number; seed?: number; avoid?: THREE.Vector3[] };
  /** seconds to hold at a reached roam goal (e.g. checking a room while clearing a building) */
  dwellAt?(p: THREE.Vector3, bot: Bot): number;
  /** true while the bot is on an objective mission (keeps it on task) */
  preferObjective?(bot: Bot): boolean;
  /** seconds between character-controller moves (0 = every frame) */
  moveInterval?(bot: Bot): number;
  /** seconds between animation/IK updates for this bot (0 = every frame) */
  animInterval?(bot: Bot): number;
  /** animation events with a world position (third-person mag drops) */
  animEvent?(bot: Bot, ev: string, pos: THREE.Vector3): void;
  /** soldiers wear their goggles down */
  night?(): boolean;
  /** directional cover per nav node */
  cover?: CoverMap;
  /** cover spots taken, per team (node ids) */
  coverClaims?: [Set<number>, Set<number>];
  /** how exposed a combatant is (stance, motion, muzzle flash, foliage) */
  exposure?(c: Combatant): Exposure;
  /** this bot's fireteam leader (null: leads itself) and its slot in the formation */
  squad?(bot: Bot): { leader: Bot | null; slot: number };
  /** teammates already working round a flank on this target */
  flanking?(bot: Bot, target: Combatant): number;
  /** game time (s) */
  time?(): number;
  /** how far soldiers can see right now (fog / snowstorm shrink it) */
  viewDist?(): number;
  callout?: (from: Bot, enemyPos: THREE.Vector3, enemy?: Combatant) => void;
  /** lob a frag at a position (bots carry one per life) */
  throwGrenade?(bot: Bot, at: THREE.Vector3, cooked?: number): void;
  /** throw a tactical (flash / stun / smoke) */
  throwTactical?(bot: Bot, at: THREE.Vector3, kind: 'flash' | 'stun' | 'smoke'): void;
  /** smoke between two points blocks sight */
  smokeBlocks?(a: THREE.Vector3, b: THREE.Vector3): boolean;
  /** radio chatter: "Reloading!", "Frag out!" ... */
  voice?(bot: Bot, line: string): void;
  difficulty: number; // 0..1
}

const DIFF = [
  { reaction: 0.85, spread: 2.5, aimSpeed: 3.5, burst: [2, 4] },
  { reaction: 0.52, spread: 1.4, aimSpeed: 5.5, burst: [3, 5] },
  { reaction: 0.36, spread: 0.95, aimSpeed: 8.0, burst: [3, 7] },
];

type State = 'roam' | 'engage' | 'search' | 'cover' | 'dead';
export type Intent = 'objective' | 'engage' | 'cover' | 'flank' | 'search' | 'investigate' | 'retreat' | 'regroup' | 'order' | 'evade';
const DEFAULT_EXPOSURE: Exposure = { stance: 'stand', speed: 2, sinceFire: 99, suppressed: false, foliage: 0, lit: false };
/** a combatant's velocity, when it has one we can read */
function velocityOf(c: Combatant): THREE.Vector3 | null {
  const a = c as unknown as { velocity?: THREE.Vector3; pc?: { vel: THREE.Vector3 } };
  return a.velocity ?? a.pc?.vel ?? null;
}

export class Bot implements Combatant {
  isPlayer = false;
  // health / alive guard puppets: a combatant owned by another machine only changes through the network
  private _health = 100;
  private _alive = false;
  get health() {
    return this._health;
  }
  set health(v: number) {
    if (this.netPuppet && v < this._health && !NETF.allowPuppetDeath) return;
    this._health = v;
  }
  get alive() {
    return this._alive;
  }
  set alive(v: boolean) {
    if (this.netPuppet && !v && !NETF.allowPuppetDeath) return;
    this._alive = v;
  }
  /** owned by another machine (network): posed from snapshots, no AI */
  netPuppet = false;
  /** a remote human controls this slot (vs a bot simulated by the host) */
  netHuman = false;
  /** disabled slot (bot count reduced): never spawns */
  netDisabled = false;
  private netTarget: Float32Array | null = null;
  private netCur = new Float32Array(POSE_N);
  private netDeadT = 0;
  /** the bot's own name, restored when a human leaves the slot */
  botName = '';
  kills = 0;
  deaths = 0;
  score = 0;
  assists = 0;
  body: CharacterBody;
  root = new THREE.Group();
  model: THREE.Object3D;
  soldier: Soldier;
  /** the animation inputs, rebuilt every frame from what the bot is doing */
  anim: AnimState = newAnimState();
  private throwT = -1;
  /**
   * the throw in progress (Update 31): the grenade only leaves the hand at the release point of the
   * animation; a frag may be cooked first (held cocked while the fuse burns)
   */
  private pending: { lethal: boolean; tk: 'flash' | 'stun' | 'smoke'; at: THREE.Vector3; cook: number; cooked: number; item: string } | null = null;
  /** sticky grenades instead of frags (set by the game) */
  sticky = false;
  private reloadDur = 1;
  weapon: WeaponModel;
  def: WeaponDef;
  mag = 30;
  state: State = 'roam';
  shots = 0;
  private vel = new THREE.Vector3();
  yaw = 0; // body facing
  aimYaw = 0;
  aimPitch = 0;
  private path: THREE.Vector3[] = [];
  private repathT = 0;
  private goal = new THREE.Vector3();
  target: Combatant | null = null;
  private lastSeen = new THREE.Vector3();
  private lastSeenT = 99;
  private perceiveT = 0;
  private reactT = 0;
  private aimErr = new THREE.Vector2();
  private fireCd = 0;
  private burstLeft = 0;
  private burstPause = 0;
  private reloadT = 0;
  private strafeDir = 1;
  private strafeT = 0;
  private stuckT = 0;
  stuckHops = 0;
  private dwellT = -1;
  private animAcc = 0;
  private moveAcc = 0;
  private lastPos = new THREE.Vector3();
  crouch = false;
  private bones: Record<string, THREE.Bone> = {};
  private deathT = 0;
  private fallAxis = new THREE.Vector3();
  private stepPhase = 0;
  lastDamageT = 99;
  lastAttacker: Combatant | null = null;
  heardAt: THREE.Vector3 | null = null;
  private rng: RNG;
  moveSpeed = 0;
  private wantCrouchT = 0;
  respawnT = 0;
  goalSet = 0;
  get velocity() {
    return this.vel;
  }
  get goalPos() {
    return this.goal;
  }
  private hitbox = { head: new THREE.Vector3(), neck: new THREE.Vector3(), hips: new THREE.Vector3(), lf: new THREE.Vector3(), rf: new THREE.Vector3(), lh: new THREE.Vector3(), rh: new THREE.Vector3(), ls: new THREE.Vector3(), rs: new THREE.Vector3() };
  gunMesh: THREE.Mesh | null = null;
  /** low-poly stand-in drawn beyond ~12 m */
  gunProxy: THREE.Mesh | null = null;
  private gunNear = true;
  visibleToPlayer = false;

  constructor(public id: number, public name: string, public team: 0 | 1, look: SoldierLook | null, weaponModel: WeaponModel, defId: keyof typeof WEAPONS, private w: BotWorld) {
    this.rng = new RNG(id * 7919 + 13);
    this.tacKind = (['flash', 'stun', 'smoke'] as const)[id % 3];
    this.def = WEAPONS[defId];
    this.body = new CharacterBody(w.physics, new THREE.Vector3(0, -100, 0));
    this.weapon = weaponModel;
    this.weapon.root.scale.setScalar(1);
    this.weapon.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    // our own soldier: skeleton, one skinned mesh (role kit + per-soldier variety), team camo
    this.soldier = new Soldier(look ?? { role: roleFor(this.def.cls, this.def.id), seed: id * 31 + 7 }, team, weaponModel);
    this.model = this.soldier.model;
    this.bones = this.soldier.bones;
    this.root.add(this.model);
    this.anim.reloadStyle = reloadStyleFor(this.def);
    this.anim.pistol = this.def.cls === 'Pistol';
    // third-person guns never animate their parts: bake ~25 meshes (5-7 materials, lens shaders)
    // into ONE vertex-coloured mesh — one draw + one shadow draw per bot gun
    // distance stand-in (~200 triangles instead of 20-40k) built from the same parts
    const proxyGeo = bakeProxy(this.weapon.root, 'botgun:' + defId);
    this.gunMesh = bakeFlat(this.weapon.root, 'botgun', 'botgun:' + defId);
    if (this.gunMesh) {
      this.gunProxy = new THREE.Mesh(proxyGeo, this.gunMesh.material);
      this.gunProxy.name = 'gunProxy';
      this.gunProxy.visible = false;
      this.gunProxy.castShadow = false;
      this.weapon.root.add(this.gunProxy);
    }
    this.mag = this.def.mag;
    this.frags = 1;
    this.nadeCd = 6 + this.rng.range(0, 8);
    this.tacticals = 1;
    this.blindT = this.stunT = 0;
    this.ragdollOn = false;
    this.root.visible = false;
  }

  position() {
    return this.body.pos;
  }

  private visLod = -1;
  /** Render LOD by camera distance: mesh detail level, shadows only near, gun stand-in far. */
  visualLod(d: number) {
    const near = d < (this.gunNear ? 13 : 11);
    if (near !== this.gunNear && this.gunMesh && this.gunProxy) {
      this.gunNear = near;
      this.gunMesh.visible = near;
      this.gunProxy.visible = !near;
    }
    // (hysteresis so a soldier on a boundary doesn't flip every frame)
    const cur = this.visLod;
    const lv = d < (cur === 0 ? 17 : 14) ? 0 : d < (cur === 1 ? 46 : 40) ? 1 : 2;
    if (lv === cur) return;
    this.visLod = lv;
    this.soldier.setLod(this.legsOnly ? 0 : lv);
    this.soldier.mesh.castShadow = lv < 2 || this.legsOnly;
    if (this.gunMesh) this.gunMesh.castShadow = d < 22;
  }
  eye(out = new THREE.Vector3()) {
    return out.copy(this.body.pos).setY(this.body.pos.y + (this.crouch ? 1.05 : 1.58));
  }
  chest(out = new THREE.Vector3()) {
    return out.copy(this.body.pos).setY(this.body.pos.y + (this.crouch ? 0.85 : 1.25));
  }
  lookDir(out = new THREE.Vector3()) {
    const cp = Math.cos(this.aimPitch);
    return out.set(-Math.sin(this.aimYaw) * cp, Math.sin(this.aimPitch), -Math.cos(this.aimYaw) * cp);
  }

  spawn(p: THREE.Vector3, yaw: number) {
    this.body.setStance('stand', true);
    this.body.teleport(p);
    this.body.setEnabled(true);
    this.health = 100;
    this.alive = true;
    this.state = 'roam';
    this.yaw = this.aimYaw = yaw;
    this.aimPitch = 0;
    this.path = [];
    this.target = null;
    this.lastSeenT = 99;
    this.mag = this.def.mag;
    this.reloadT = 0;
    this.deathT = 0;
    this.heardAt = null;
    this.root.visible = true;
    this.model.rotation.set(0, 0, 0);
    this.model.position.set(0, 0, 0);
    this.crouch = false;
    this.stanceCur = 'stand';
    this.lean = 0;
    this.slideT = 0;
    this.suppression = 0;
    this.intent = 'objective';
    this.evadeT = 0;
    this.releaseCover();
    this.aware.length = 0;
    this.order = null;
    this.blocked.length = 0;
    this.repathT = 0;
    this.lastDamageT = 99;
    this.weapon.root.visible = true;
  }

  kill(dir: THREE.Vector3) {
    this.alive = false;
    this.state = 'dead';
    this.deathT = 0;
    this.body.setEnabled(false);
    // fall along the bullet direction
    const d = dir.clone().setY(0).normalize();
    this.fallAxis.set(d.z, 0, -d.x);
    this.respawnT = 5;
    // headshots crumple on the spot; heavy hits throw the body back; others twist and fall
    this.deathStyle = this.lastHitPart === 'head' ? 1 : this.rng.chance(0.45) ? 2 : 0;
    if (this.deathStyle === 1) this.fallAxis.multiplyScalar(-0.6).add(new THREE.Vector3(this.rng.range(-0.4, 0.4), 0, this.rng.range(-0.4, 0.4))).normalize();
    this.deathSpin = this.deathStyle === 2 ? this.rng.range(-1.2, 1.2) : 0;
    // physical fall: the ragdoll takes over from the animation
    this.ragdoll ??= new Ragdoll(this.bones, this.w.physics);
    this.ragdollOn = this.ragdoll.ok && !this.legsOnly;
    if (this.ragdollOn) {
      this.model.updateMatrixWorld(true);
      const v = this.vel.clone();
      v.y = Math.max(0, v.y);
      this.ragdoll.start(v, dir.clone().normalize(), this.lastHitPart);
    }
  }
  private ragdoll: Ragdoll | null = null;
  private ragdollOn = false;
  private deathSpin = 0;

  // hit reactions
  private flinch = new Spring(220, 14);
  private headSnap = new Spring(260, 16);
  private flinchAxis = new THREE.Vector3(1, 0, 0);
  private deathStyle = 0;
  private lastHitPart: HitPart = 'body';
  private stagger = 0;

  onDamaged(from: Combatant | null, amount = 20, dir?: THREE.Vector3, part: HitPart = 'body') {
    if (this.netPuppet) {
      // direct hit on a combatant owned elsewhere: its owner applies it
      if (from && !NETF.noRoute && !NETF.allowPuppetDeath && dir) NETF.route?.(this, from, amount, dir, part, NETF.weapon);
      return;
    }
    this.lastDamageT = 0;
    this.lastHitPart = part;
    if (dir && this.alive) {
      // torso twists away from the impact, head snaps on headshots, body is shoved
      const h = dir.clone().setY(0).normalize();
      this.flinchAxis.set(h.z, 0, -h.x);
      this.flinch.impulse(clamp(amount / 25, 0.3, 2.2) * 4.2 * (part === 'limb' ? 0.55 : 1));
      if (part === 'head') this.headSnap.impulse(9);
      this.vel.addScaledVector(h, clamp(amount / 30, 0.25, 1.5) * (part === 'limb' ? 1.5 : 2.6));
      this.stagger = Math.max(this.stagger, clamp(amount / 60, 0.12, 0.4));
      this.aimErr.x += (this.rng.next() - 0.5) * 0.08;
      this.aimErr.y += this.rng.next() * 0.05;
      this.burstPause = Math.max(this.burstPause, 0.12);
    }
    if (from && this.alive && amount > 20 && this.rng.chance(0.35)) this.w.voice?.(this, this.target ? 'hurt' : 'taking');
    if (from && this.alive) {
      this.lastAttacker = from;
      this.lastSeen.copy(from.position());
      this.lastSeenT = 0;
      if (!this.target || !this.target.alive) this.target = from;
      this.suppression = Math.min(1, this.suppression + 0.35);
      this.decideT = Math.min(this.decideT, 0.1);
    }
  }

  frags = 1;
  private nadeCd = 8;
  /** tactical equipment (one per life) and status effects */
  tacKind: 'flash' | 'stun' | 'smoke' = 'flash';
  tacticals = 1;
  blindT = 0;
  stunT = 0;
  blind(d: number) {
    if (!this.alive) return;
    this.blindT = Math.max(this.blindT, d);
    this.w.voice?.(this, 'blind');
  }
  stun(d: number) {
    if (!this.alive) return;
    this.stunT = Math.max(this.stunT, d);
  }
  /** run from a live grenade */
  flee(from: THREE.Vector3) {
    if (!this.alive || this.intent === 'evade') return;
    const away = this.body.pos.clone().sub(from).setY(0);
    if (away.lengthSq() < 0.01) away.set(this.rng.range(-1, 1), 0, this.rng.range(-1, 1));
    away.setLength(11);
    const goal = this.w.nav.nearest(this.body.pos.clone().add(away), 12)?.p ?? this.body.pos.clone().add(away);
    this.path = this.w.nav.path(this.body.pos, goal) ?? [goal.clone()];
    this.goal.copy(goal);
    this.moveGoal.copy(goal);
    this.setIntent('evade');
    this.evadeT = 2.6;
    this.repathT = 3;
  }

  /**
   * A sound or a teammate's callout: a rough position (worse further away) and, when known, who
   * made it — awareness of them rises without spotting them.
   */
  hear(p: THREE.Vector3, src?: Combatant | null, strength = 0.35) {
    if (!this.alive) return;
    if (src && src.team !== this.team) {
      const e = this.awareOf(src);
      e.a = Math.min(0.95, Math.max(e.a, strength));
    }
    if (this.intent === 'engage' && this.target && this.lastSeenT < 1) return;
    const d = p.distanceTo(this.body.pos);
    const fuzz = Math.min(12, d * 0.12);
    this.heardAt = p.clone().add(new THREE.Vector3((this.rng.next() - 0.5) * fuzz, 0, (this.rng.next() - 0.5) * fuzz));
  }
  /** rounds cracking past: suppression builds up */
  suppress(amount: number, from?: Combatant | null) {
    if (!this.alive) return;
    this.suppression = Math.min(1, this.suppression + amount);
    if (from && from.team !== this.team) {
      const e = this.awareOf(from);
      e.a = Math.min(1.2, e.a + amount * 0.8);
      if (!this.target) this.heardAt = from.position().clone();
    }
  }
  /** what this soldier exposes to enemy eyes */
  exposure(): Exposure {
    const e = this.expo;
    e.stance = this.stanceCur === 'prone' ? 'prone' : this.stanceCur === 'crouch' ? 'crouch' : 'stand';
    e.speed = this.moveSpeed;
    e.sinceFire = this.sinceShot;
    e.suppressed = !!this.def.sound.suppressed;
    e.lit = !!this.w.night?.() && !this.irGearPublic;
    return e;
  }
  private expo: Exposure = { stance: 'stand', speed: 0, sinceFire: 99, suppressed: false, foliage: 0, lit: false };
  get irGearPublic() {
    return this.id % 2 === 0;
  }

  // ---------------------------------------------------------------- hit test
  private updateHitbox() {
    const b = this.bones;
    const get = (n: string, out: THREE.Vector3) => (b[n] ? b[n].getWorldPosition(out) : out.copy(this.body.pos));
    get('Head', this.hitbox.head);
    get('Neck', this.hitbox.neck);
    get('Hips', this.hitbox.hips);
    get('LeftFoot', this.hitbox.lf);
    get('RightFoot', this.hitbox.rf);
    get('LeftHand', this.hitbox.lh);
    get('RightHand', this.hitbox.rh);
    get('LeftArm', this.hitbox.ls);
    get('RightArm', this.hitbox.rs);
    this.hitbox.head.y += 0.07;
    this.hbAt.copy(this.root.position);
  }
  /** where the root was when the hitbox was taken (animation LOD updates it at 15-30 Hz for far
   *  soldiers; hit tests shift it by how far the body has moved since, so it never lags) */
  private hbAt = new THREE.Vector3();
  private hbO = new THREE.Vector3();

  hitTest(o: THREE.Vector3, d: THREE.Vector3, max: number): { dist: number; part: HitPart; point: THREE.Vector3 } | null {
    if (!this.alive) return null;
    // broad phase
    const c = this.chest();
    const toC = c.clone().sub(o);
    const t = toC.dot(d);
    if (t < 0 || t > max + 2) return null;
    if (toC.clone().addScaledVector(d, -t).lengthSq() > 2.5) return null;
    const h = this.hitbox;
    // ray origin in the hitbox's frame (the body may have moved since it was taken)
    o = this.hbO.copy(o).sub(this.root.position).add(this.hbAt);
    let best: { dist: number; part: HitPart } | null = null;
    const test = (dist: number | null, part: HitPart) => {
      if (dist !== null && dist <= max && (!best || dist < best.dist)) best = { dist, part };
    };
    test(raySphere(o, d, h.head, 0.15), 'head');
    test(rayCapsule(o, d, h.neck, h.hips, 0.22), 'body');
    test(rayCapsule(o, d, h.hips, h.lf, 0.13), 'limb');
    test(rayCapsule(o, d, h.hips, h.rf, 0.13), 'limb');
    test(rayCapsule(o, d, h.ls, h.lh, 0.08), 'limb');
    test(rayCapsule(o, d, h.rs, h.rh, 0.08), 'limb');
    if (!best) return null;
    const bb = best as { dist: number; part: HitPart };
    return { dist: bb.dist, part: bb.part, point: o.clone().addScaledVector(d, bb.dist).add(this.root.position).sub(this.hbAt) };
  }

  // ---------------------------------------------------------------- AI
  // ================================================================= brain
  /**
   * Perception without wallhacks: every enemy has an awareness level that builds up while it can
   * actually be seen (line of sight, not hidden by smoke) at a rate set by distance, where it is in
   * the field of view (focal / peripheral), stance, movement, muzzle flash, night and foliage — and
   * decays when it can't. ≥ 1 means spotted. Sounds and teammates' callouts raise awareness and give
   * a rough position, never a perfect one.
   */
  private aware: { c: Combatant; a: number }[] = [];
  private awareOf(c: Combatant) {
    let e = this.aware.find((x) => x.c === c);
    if (!e) this.aware.push((e = { c, a: 0 }));
    return e;
  }
  /** awareness of a combatant (0..2; ≥ 1 spotted) — read by the AI debug overlay */
  awareness(c: Combatant) {
    return this.aware.find((x) => x.c === c)?.a ?? 0;
  }
  private percAcc = 0;
  private sEye = new THREE.Vector3();
  private sFwd = new THREE.Vector3();
  private sT1 = new THREE.Vector3();
  private sT2 = new THREE.Vector3();
  private perceive(dt: number) {
    if (this.blindT > 0) return;
    const eye = this.eye(this.sEye);
    const fwd = this.lookDir(this.sFwd);
    const view = this.w.viewDist?.() ?? 160;
    const night = !!this.w.night?.();
    let best: Combatant | null = null, bs = Infinity, bd = 0;
    for (const c of this.w.combatants()) {
      if (c.team === this.team || !c.alive) continue;
      const e = this.awareOf(c);
      const cp = c.chest(this.sT1);
      const dx = cp.x - eye.x, dy = cp.y - eye.y, dz = cp.z - eye.z;
      const dist = Math.hypot(dx, dy, dz) || 1e-3;
      let rate = 0;
      if (dist < view) {
        const ex = this.w.exposure?.(c) ?? DEFAULT_EXPOSURE;
        rate = detectRate(dist, view, (dx * fwd.x + dy * fwd.y + dz * fwd.z) / dist, ex, night);
        // the one who just shot you: you know which way to look
        if (c === this.lastAttacker && this.lastDamageT < 2) rate = Math.max(rate, 4);
        if (rate > 0) {
          const los = this.w.physics.lineOfSight(eye, cp) || this.w.physics.lineOfSight(eye, c.eye(this.sT2));
          if (!los || this.w.smokeBlocks?.(eye, cp)) rate = 0;
        }
      }
      if (rate > 0) {
        e.a = Math.min(2, e.a + rate * dt * (0.8 + this.w.difficulty * 0.5));
        if (e.a >= 1) {
          if (c === this.target) {
            this.lastSeen.copy(c.position());
            this.lastSeenT = 0;
          }
          const score = dist * (c === this.target ? 0.6 : 1) * (c === this.lastAttacker ? 0.5 : 1);
          if (score < bs) {
            bs = score;
            best = c;
            bd = dist;
          }
        }
      } else e.a = Math.max(0, e.a - dt * (e.a >= 1 ? 0.06 : 0.3));
    }
    if (best) this.acquire(best, bd);
  }
  private acquire(c: Combatant, dist: number) {
    if (c !== this.target || this.lastSeenT > 1.0) {
      if (this.rng.chance(0.45) && (c !== this.target || this.lastSeenT > 4)) this.w.voice?.(this, 'contact');
      const sk = this.skill();
      this.reactT = sk.reaction * this.rng.range(0.75, 1.35) * (this.intent === 'engage' ? 0.6 : 1);
      this.aimCtl.acquire(sk, dist, () => this.rng.next());
      this.w.callout?.(this, c.position(), c);
    }
    this.target = c;
    this.lastSeen.copy(c.position());
    this.lastSeenT = 0;
  }
  skill() {
    return SKILL[Math.round(this.w.difficulty * 2)];
  }

  // ---- decisions
  /** what the soldier is trying to do right now (utility-scored, re-evaluated ~2× a second) */
  intent: Intent = 'objective';
  private intentT = 0;
  private decideT = 0;
  /** suppression from rounds cracking past (0..1): worse aim, more cover, lower stance */
  suppression = 0;
  /** player / squad order */
  order: Order | null = null;
  /** recently noted intent scores (AI debug overlay) */
  scores: Partial<Record<Intent, number>> = {};
  private evadeT = 0;
  private flankGoal: THREE.Vector3 | null = null;
  private dwellLook = 0;

  private decide(visible: boolean) {
    const now = this.w.time?.() ?? 0;
    const hp = this.health / 100;
    const t = this.target;
    const tDist = t ? t.position().distanceTo(this.body.pos) : 1e9;
    const reloading = this.reloadT > 0;
    const sc: Partial<Record<Intent, number>> = {};
    if (this.evadeT > 0) sc.evade = 2;
    if (this.order && this.order.until < now) this.order = null;
    sc.objective = 0.38 + (this.w.preferObjective?.(this) ? 0.1 : 0);
    if (t && this.lastSeenT < 3) {
      sc.engage = (visible ? 0.82 : this.lastSeenT > 1.2 ? 0.45 : 0.6) + 0.12 * hp - this.suppression * 0.3 - (reloading ? 0.25 : 0);
      const pressed = (1 - hp) * 0.7 + this.suppression * 0.6 + (reloading && visible ? 0.4 : 0) + (this.lastDamageT < 1.5 ? 0.2 : 0);
      sc.cover = this.w.cover ? Math.min(0.97, 0.25 + pressed) : 0;
      if (hp < 0.32 && this.nearbyEnemies() >= 2) sc.retreat = 0.9;
      const flankers = this.w.flanking?.(this, t) ?? 0;
      if (!visible && flankers < 2 && tDist > 14 && tDist < 80 && this.def.cls !== 'Sniper') sc.flank = 0.62 + this.w.difficulty * 0.1 - flankers * 0.15 + (this.id % 3 === 0 ? 0.08 : 0);
    } else if (this.lastSeenT < 12) sc.search = 0.58 - this.lastSeenT * 0.02;
    if (this.heardAt) sc.investigate = 0.5;
    const sq = this.w.squad?.(this);
    if (sq?.leader && sq.leader.alive && !t && sq.leader.position().distanceTo(this.body.pos) > 38) sc.regroup = 0.52;
    if (this.order) sc.order = visible && tDist < 45 ? 0.7 : 0.88;
    // hysteresis: stick with the current plan unless something is clearly better
    if (sc[this.intent] !== undefined) sc[this.intent]! += 0.1;
    let best: Intent = 'objective', bs = -1;
    for (const [k, v] of Object.entries(sc) as [Intent, number][]) if (v > bs) {
      bs = v;
      best = k;
    }
    this.scores = sc;
    if (best !== this.intent) this.setIntent(best);
  }
  private setIntent(i: Intent) {
    if (this.intent === 'cover' || i !== 'cover') this.releaseCover();
    this.intent = i;
    this.intentT = 0;
    this.repathT = 0;
    this.dwellT = -1;
    if (i !== 'flank') this.flankGoal = null;
    this.peekT = 0;
  }
  private nearbyEnemies() {
    let n = 0;
    for (const c of this.w.combatants()) if (c.team !== this.team && c.alive && c.position().distanceTo(this.body.pos) < 30 && this.awareness(c) >= 1) n++;
    return n;
  }

  // ---- cover
  coverNode: NavNode | null = null;
  coverQ = 0;
  private peekT = 0;
  private peeking = false;
  private releaseCover() {
    if (this.coverNode) this.w.coverClaims?.[this.team].delete(this.coverNode.id);
    this.coverNode = null;
    this.coverQ = 0;
  }
  private findCover(threat: THREE.Vector3) {
    this.releaseCover();
    const claims = this.w.coverClaims?.[this.team] ?? new Set<number>();
    const c = this.w.cover?.find(this.body.pos, threat, 24, claims);
    if (c) {
      this.coverNode = c.node;
      this.coverQ = c.q;
      claims.add(c.node.id);
      return true;
    }
    // fallback: any nearby node out of the threat's sight
    let best: NavNode | null = null, bs = -Infinity;
    for (const n of this.w.nav.near(this.body.pos, 22)) {
      if (n.links.length === 0) continue;
      const vis = this.w.physics.lineOfSight(this.sT1.copy(n.p).setY(n.p.y + 1.3), this.sT2.copy(threat).setY(threat.y + 1.4));
      const s = (vis ? -10 : 10) - n.p.distanceTo(this.body.pos) * 0.3;
      if (s > bs) {
        bs = s;
        best = n;
      }
    }
    if (best) {
      this.coverNode = best;
      this.coverQ = 1;
      return true;
    }
    return false;
  }

  // ---- movement helpers
  /** recently blocked spots (unstuck): kept out of route planning for a while */
  private blocked: { p: THREE.Vector3; until: number }[] = [];
  private pathOptions() {
    const o = this.w.pathOpts?.(this) ?? {};
    const now = this.w.time?.() ?? 0;
    this.blocked = this.blocked.filter((b) => b.until > now);
    if (!this.blocked.length) return o;
    return { ...o, avoid: [...(o.avoid ?? []), ...this.blocked.map((b) => b.p)] };
  }
  private moveGoal = new THREE.Vector3(1e9, 0, 0);
  /** path towards a goal (re-planned when the goal moves or every few seconds); true when arrived */
  private moveTo(goal: THREE.Vector3, wish: THREE.Vector3, arrive = 1.8) {
    if (goal.distanceTo(this.moveGoal) > 2.5 || this.repathT <= 0 || !this.path.length) {
      if (goal.distanceTo(this.body.pos) > arrive) {
        this.path = this.w.nav.path(this.body.pos, goal, 6000, this.pathOptions()) ?? [goal.clone()];
      } else this.path = [];
      this.moveGoal.copy(goal);
      this.repathT = 3 + this.rng.range(0, 1.5);
    }
    this.followPath(wish);
    return this.body.pos.distanceTo(goal) < arrive;
  }

  private pickGoal() {
    // objective players (Domination capture/defend) often ignore distant noise and keep to the flag
    if (this.heardAt && this.w.preferObjective?.(this) && this.rng.chance(0.85)) this.heardAt = null;
    // fireteam members move with their leader (a loose wedge around its goal)
    const sq = this.w.squad?.(this);
    let g: THREE.Vector3;
    if (sq?.leader && sq.leader.alive && sq.leader.goalPos.distanceTo(this.body.pos) < 120) {
      const lg = sq.leader.goalPos;
      const ang = (sq.slot % 2 ? 1 : -1) * (0.9 + 0.4 * Math.floor(sq.slot / 2));
      g = this.w.nav.nearest(this.sT1.set(lg.x + Math.sin(ang) * 5, lg.y, lg.z + Math.cos(ang) * 5), 10)?.p ?? lg;
    } else g = this.w.objectiveFor(this.team, this.body.pos, this);
    this.goal.copy(g);
    this.path = this.w.nav.path(this.body.pos, this.goal, 6000, this.pathOptions()) ?? [];
    this.repathT = 4 + this.rng.range(0, 2);
    this.goalSet = performance.now();
  }

  /** held in a knife takedown: posed by the attacker, no AI, no movement, no shooting */
  heldT = 0;
  heldPos = new THREE.Vector3();
  heldYaw = 0;
  hold(pos: THREE.Vector3, yaw: number, t: number) {
    this.heldPos.copy(pos);
    this.heldYaw = yaw;
    this.heldT = t;
  }

  aimCtl = new AimController();
  /** for the AI debug overlay */
  debugInfo() {
    return { path: this.path, lastSeen: this.lastSeen, lastSeenT: this.lastSeenT };
  }
  private aimCur = { yaw: 0, pitch: 0 };
  private sinceShot = 99;
  stanceCur: 'stand' | 'crouch' | 'prone' = 'stand';
  lean = 0;
  private slideT = 0;
  private slideCd = 0;
  /** separation from nearby soldiers (filled by the game every frame) */
  avoid = new THREE.Vector3();
  private stanceWantKeep(): 'stand' | 'crouch' | 'prone' {
    return this.stanceCur === 'prone' ? 'crouch' : this.stanceCur;
  }
  // ---- unstuck: no progress towards the next waypoint → side-step → hop → route round → new goal
  private wpRef: THREE.Vector3 | null = null;
  private wpBest = 1e9;
  private noProg = 0;
  stuckStage = 0;
  private sideT = 0;
  private sideDir = 1;
  private unstuck(dt: number, wish: THREE.Vector3, speed: number, now: number) {
    if (this.sideT > 0) {
      this.sideT -= dt;
      wish.add(this.sT2.set(-wish.z, 0, wish.x).multiplyScalar(this.sideDir * 1.3));
    }
    const wp = this.path[0];
    const following = this.followedPath;
    this.followedPath = false;
    if (!wp || speed < 1 || !following) {
      this.noProg = 0;
      return;
    }
    if (wp !== this.wpRef) {
      this.wpRef = wp;
      this.wpBest = 1e9;
      this.noProg = 0;
      this.stuckStage = 0;
    }
    const dW = Math.hypot(wp.x - this.body.pos.x, wp.z - this.body.pos.z);
    if (dW < this.wpBest - 0.12) {
      this.wpBest = dW;
      this.noProg = 0;
      return;
    }
    this.noProg += dt;
    if (this.noProg < 1.0) return;
    this.noProg = 0;
    this.wpBest = dW;
    this.stuckStage++;
    this.stuckHops++;
    if (this.stuckStage === 1) {
      this.sideT = 0.7;
      this.sideDir = this.rng.chance(0.5) ? 1 : -1;
    } else if (this.stuckStage === 2) {
      if (this.body.grounded) this.vel.y = 6.2;
      this.sideT = 0.5;
      this.sideDir = -this.sideDir;
    } else if (this.stuckStage === 3) {
      // route round it: this spot stays out of planning for a while
      this.blocked.push({ p: wp.clone(), until: now + 15 });
      this.path = [];
      this.repathT = 0;
    } else {
      this.stuckStage = 0;
      this.blocked.push({ p: this.body.pos.clone(), until: now + 15 });
      this.pickGoal();
      this.decideT = 0;
    }
  }

  // per-frame scratch vectors (Bot.update used to allocate several per bot per frame)
  private sWish = new THREE.Vector3();
  private sTo = new THREE.Vector3();
  private sSide = new THREE.Vector3();
  private sMove = new THREE.Vector3();
  private sAim = new THREE.Vector3();
  update(dt: number, now: number) {
    if (!this.alive) {
      this.updateDeath(dt);
      return;
    }
    if (this.heldT > 0) {
      this.heldT -= dt;
      this.body.pos.lerp(this.heldPos, 1 - Math.exp(-dt * 18));
      this.body.teleport(this.body.pos);
      let dy = wrapAngle(this.heldYaw - this.yaw);
      this.yaw += dy * (1 - Math.exp(-dt * 16));
      this.aimYaw = this.yaw;
      this.aimPitch = 0.1;
      this.vel.set(0, 0, 0);
      this.moveSpeed = 0;
      this.root.position.copy(this.body.pos);
      this.root.rotation.y = this.yaw + Math.PI;
      this.poseSoldier(dt * 0.4);
      this.updateHitbox();
      void dy;
      return;
    }
    this.lastSeenT += dt;
    this.lastDamageT += dt;
    this.sinceShot += dt;
    this.suppression = Math.max(0, this.suppression - dt * 0.3);
    this.evadeT -= dt;
    this.perceiveT -= dt;
    this.percAcc += dt;
    if (this.perceiveT <= 0) {
      this.perceiveT = 0.15 + this.rng.range(0, 0.08);
      this.perceive(this.percAcc);
      this.percAcc = 0;
    }
    if (this.target && (!this.target.alive || this.lastSeenT > 3)) {
      if (!this.target.alive) {
        this.lastSeenT = 99;
        const e = this.aware.find((x) => x.c === this.target);
        if (e) e.a = 0;
      }
      this.target = null;
    }
    const sk = this.skill();
    const d = DIFF[Math.round(this.w.difficulty * 2)];
    const visible = !!this.target && this.lastSeenT < 0.35;
    // ---------------- decide ----------------
    this.decideT -= dt;
    if (this.decideT <= 0) {
      this.decideT = 0.4 + this.rng.range(0, 0.3);
      this.decide(visible);
    }
    this.intentT += dt;
    const it = this.intent;
    this.state = it === 'engage' || it === 'flank' ? (this.target ? 'engage' : 'search') : it === 'cover' || it === 'retreat' || it === 'evade' ? 'cover' : it === 'search' || it === 'investigate' ? 'search' : 'roam';
    const now2 = this.w.time?.() ?? now;

    // ---------------- movement intent ----------------
    const wish = this.sWish.set(0, 0, 0);
    let speed = 0;
    let wantStance: 'stand' | 'crouch' | 'prone' = 'stand';
    let wantLean = 0;
    let suppressFire = false;
    const threat = this.target ? this.target.position() : this.lastSeenT < 12 ? this.lastSeen : this.heardAt;
    const longRange = this.def.cls === 'Sniper' || this.def.cls === 'Marksman' || this.def.cls === 'LMG';
    this.repathT -= dt;
    switch (it) {
      case 'engage': {
        const tp = this.target ? this.target.position() : this.lastSeen;
        const dist = tp.distanceTo(this.body.pos);
        const ideal = this.def.cls === 'Shotgun' ? 8 : this.def.cls === 'SMG' ? 16 : this.def.cls === 'Sniper' ? 60 : this.def.cls === 'Marksman' ? 42 : 28;
        this.strafeT -= dt;
        if (this.strafeT <= 0) {
          this.strafeT = this.rng.range(0.6, 1.6);
          this.strafeDir = this.rng.chance(0.5) ? 1 : -1;
          if (this.rng.chance(0.25) && dist > 15) this.strafeDir = 0;
          this.wantCrouchT = this.rng.chance(dist > 30 ? 0.35 : 0.12) ? this.rng.range(0.8, 2) : 0;
        }
        const to = this.sTo.copy(tp).sub(this.body.pos).setY(0).normalize();
        const side = this.sSide.set(-to.z, 0, to.x);
        const pushObj = visible && dist > 22 && this.w.preferObjective?.(this) && this.goal.distanceTo(this.body.pos) > 3;
        // long guns at range settle down prone (or crouched) and stop strafing
        const settle = visible && longRange && dist > 32 && !pushObj;
        if (settle) {
          wantStance = this.body.fits('prone') ? 'prone' : 'crouch';
        } else {
          if (pushObj) {
            if (!this.path.length || this.repathT <= 0) {
              this.path = this.w.nav.path(this.body.pos, this.goal, 6000, this.pathOptions()) ?? [];
              this.repathT = 3;
            }
            this.followPath(wish);
            wish.multiplyScalar(0.85).addScaledVector(side, this.strafeDir * 0.3);
          } else wish.addScaledVector(side, this.strafeDir);
          if (dist > ideal + 12 && visible) wish.addScaledVector(to, 0.9);
          else if (dist < ideal * 0.5) wish.addScaledVector(to, -0.6);
          if (this.wantCrouchT > 0 && this.def.cls !== 'Shotgun') wantStance = 'crouch';
        }
        if (!visible) {
          // lost sight briefly: someone else is flanking → keep them pinned with suppressive fire,
          // otherwise push to the last known position
          const flankers = this.target ? this.w.flanking?.(this, this.target) ?? 0 : 0;
          if (flankers > 0 && this.lastSeenT < 3.5 && dist < 70) {
            suppressFire = true;
            wish.set(0, 0, 0);
            wantStance = longRange ? wantStance : 'crouch';
          } else this.moveTo(this.lastSeen, wish, 2);
        }
        speed = visible ? (settle ? 0 : this.stanceCur !== 'stand' ? 1.8 : pushObj ? 3.6 : 3.2) : 5.0;
        break;
      }
      case 'cover': {
        if (!threat) break;
        if (!this.coverNode || (this.intentT > 0.5 && this.w.cover && this.coverQ && this.w.cover.quality(this.coverNode, threat) === 0)) {
          if (!this.findCover(threat)) {
            this.setIntent('engage');
            break;
          }
        }
        const cn = this.coverNode!;
        const there = this.moveTo(cn.p, wish, 1.1);
        speed = there ? 0 : 6.2;
        if (!there) {
          // closing the last few metres at a sprint: slide into it
          const dc = cn.p.distanceTo(this.body.pos);
          if (dc < 5.5 && dc > 2.5 && this.moveSpeed > 5 && this.slideT <= 0 && this.slideCd <= 0 && this.rng.chance(0.4)) {
            this.slideT = 0.65;
            this.slideCd = 6;
          }
        } else {
          // peek cycle: hide (duck / stay behind the wall) ⇄ peek (stand up / lean out) and shoot
          this.peekT -= dt;
          if (this.peekT <= 0) {
            this.peeking = !this.peeking && this.reloadT <= 0;
            this.peekT = this.peeking ? this.rng.range(1.2, 2.4) : this.rng.range(0.9, 2.0) + this.suppression * 1.5;
          }
          const full = this.coverQ >= 2;
          if (full) {
            wantStance = this.suppression > 0.6 ? 'crouch' : 'stand';
            wantLean = this.peeking ? this.w.cover?.leanSide(cn, threat) ?? 1 : 0;
          } else wantStance = this.peeking ? 'stand' : 'crouch';
        }
        break;
      }
      case 'flank': {
        const tp = this.target ? this.target.position() : this.lastSeen;
        if (!this.flankGoal) {
          // a point off to one side of the enemy, 18–28 m out, reached by a detour
          const away = this.sT1.copy(this.body.pos).sub(tp).setY(0).normalize();
          const sideSign = this.id % 2 ? 1 : -1;
          const side = this.sT2.set(-away.z * sideSign, 0, away.x * sideSign);
          const want = tp.clone().addScaledVector(side, this.rng.range(18, 28)).addScaledVector(away, this.rng.range(2, 8));
          this.flankGoal = this.w.nav.nearest(want, 14)?.p.clone() ?? want;
        }
        const there = this.moveTo(this.flankGoal, wish, 2.5);
        speed = 5.6;
        if (there) this.setIntent('search');
        break;
      }
      case 'search':
      case 'investigate': {
        const tgt = it === 'search' ? this.lastSeen : this.heardAt ?? this.lastSeen;
        const there = this.moveTo(tgt, wish, 2.2);
        speed = it === 'search' ? 4.4 : 3.6;
        if (there) {
          // look around the spot
          this.dwellLook += dt;
          this.aimYaw += Math.sin(now * 1.7 + this.id) * dt * 1.6;
          speed = 0;
          if (this.dwellLook > 2.5) {
            this.dwellLook = 0;
            if (it === 'investigate') this.heardAt = null;
            else this.lastSeenT = Math.max(this.lastSeenT, 12);
            this.decideT = 0;
          }
        } else this.dwellLook = 0;
        wantStance = it === 'search' && this.def.cls !== 'Shotgun' && this.rng.chance(0.002) ? 'crouch' : this.stanceWantKeep();
        break;
      }
      case 'retreat': {
        if (threat && (!this.path.length || this.repathT <= 0)) {
          const away = this.sT1.copy(this.body.pos).sub(threat).setY(0).normalize().multiplyScalar(22);
          const g = this.w.nav.nearest(this.sT2.copy(this.body.pos).add(away), 14)?.p ?? this.body.pos;
          this.moveTo(g, wish, 2);
        } else this.followPath(wish);
        speed = 6.2;
        if (!this.path.length) this.setIntent('cover');
        break;
      }
      case 'regroup': {
        const sq = this.w.squad?.(this);
        const lp = sq?.leader?.position();
        if (lp) {
          const there = this.moveTo(lp, wish, 6);
          speed = there ? 0 : 5.4;
        }
        break;
      }
      case 'order': {
        const o = this.order!;
        if (!o) break;
        const goal = o.kind === 'follow' || o.kind === 'regroup' ? (o.who?.position() ?? o.pos) : o.pos;
        const there = this.moveTo(goal, wish, o.kind === 'follow' ? 5 : 2.5);
        speed = there ? 0 : o.kind === 'attack' ? 5.6 : 5;
        if (there && (o.kind === 'defend' || o.kind === 'hold')) {
          this.aimYaw += Math.sin(now * 1.3 + this.id) * dt * 1.2;
          wantStance = o.kind === 'hold' ? 'crouch' : 'stand';
        }
        if (there && o.kind === 'regroup') this.order = null;
        break;
      }
      case 'evade': {
        this.followPath(wish);
        speed = 6.4;
        if (!this.path.length || this.evadeT <= 0) {
          this.evadeT = 0;
          this.decideT = 0;
        }
        break;
      }
      default: {
        // objective: missions from the team director (fireteams follow their leader)
        const atGoal = this.body.pos.distanceTo(this.goal) < 2.2;
        if (atGoal && this.dwellT < 0) this.dwellT = this.w.dwellAt?.(this.goal, this) ?? 0;
        if (this.dwellT > 0) {
          this.dwellT -= dt;
          this.path = [];
          this.aimYaw += Math.sin(now * 1.6 + this.id) * dt * 1.4;
          if (this.dwellT <= 0) {
            this.dwellT = -1;
            this.pickGoal();
          }
        } else if (!this.path.length || atGoal) {
          this.dwellT = -1;
          this.pickGoal();
        } else if (this.repathT <= 0) {
          const np = this.w.nav.path(this.body.pos, this.goal, 6000, this.pathOptions());
          if (np && np.length) this.path = np;
          else this.pickGoal();
          this.repathT = 4 + this.rng.range(0, 2);
        }
        this.followPath(wish);
        speed = 6.0;
      }
    }
    // ---------------- equipment ----------------
    this.nadeCd -= dt;
    if (this.target && this.frags + this.tacticals > 0 && this.nadeCd <= 0 && this.lastSeenT > 0.7 && this.lastSeenT < 5 && (it === 'engage' || it === 'search')) {
      const dd = this.lastSeen.distanceTo(this.body.pos);
      // clearing a room: flash / stun first, then the frag
      const indoor = this.w.nav.nearest(this.lastSeen, 4, false)?.indoor ?? false;
      this.nadeCd = 6 + this.rng.range(0, 8);
      if (indoor && this.tacticals > 0 && this.tacKind !== 'smoke' && dd > 4 && dd < 22 && this.rng.chance(0.7)) {
        this.tacticals--;
        this.startThrow(false, this.lastSeen.clone());
      } else if (this.frags > 0 && dd > 9 && dd < 32 && this.rng.chance(indoor ? 0.75 : 0.55)) {
        this.frags--;
        // closer targets in a room get a cooked frag (no time to throw it back / run)
        this.startThrow(true, this.lastSeen.clone(), !this.sticky && (indoor || dd < 16) && this.rng.chance(0.6) ? 0.6 + this.rng.range(0, 1.2) : 0);
      } else if (this.tacticals > 0 && dd > 7 && dd < 26 && this.tacKind !== 'smoke' && this.rng.chance(0.5)) {
        this.tacticals--;
        this.startThrow(false, this.lastSeen.clone());
      }
    }
    // smoke to cover a retreat, a dash to cover or a push across open ground
    if (this.tacKind === 'smoke' && this.tacticals > 0 && this.target && this.lastSeenT < 0.4 && (it === 'retreat' || (it === 'cover' && speed > 0) || this.health < 60)) {
      const dd = this.target.position().distanceTo(this.body.pos);
      if (dd > 16 && this.rng.chance(0.03)) {
        this.tacticals--;
        this.startThrow(false, this.body.pos.clone().lerp(this.target.position(), 0.35), 0, 'smoke');
      }
    }
    // status effects
    this.blindT = Math.max(0, this.blindT - dt);
    this.stunT = Math.max(0, this.stunT - dt);
    if (this.blindT > 0) {
      wish.set(Math.sin(now * 1.3 + this.id), 0, Math.cos(now * 0.9 + this.id)).multiplyScalar(0.4);
      speed = 1.3;
      this.burstPause = Math.max(this.burstPause, 0.3);
    }
    if (this.stunT > 0) speed *= 0.45;
    // hit stagger: a beat of lost footing after a solid hit (the shove carries them meanwhile)
    if (this.stagger > 0) { this.stagger -= dt; speed *= 0.4; }
    // heavy suppression keeps heads down
    if (this.suppression > 0.7 && wantStance === 'stand' && it !== 'evade' && speed < 4) wantStance = 'crouch';
    // local avoidance (computed for everyone by the game) and the unstuck side-step
    if (speed > 0.5) wish.addScaledVector(this.avoid, 0.9);
    else if (this.avoid.lengthSq() > 0.3) {
      wish.copy(this.avoid);
      speed = 1.5;
    }
    this.unstuck(dt, wish, speed, now2);
    if (wish.lengthSq() > 1) wish.normalize();
    // stance (the body only stands up where it fits)
    this.slideT -= dt;
    this.slideCd -= dt;
    if (this.slideT > 0) wantStance = 'crouch';
    this.wantCrouchT -= dt;
    if (wantStance !== this.stanceCur && (speed < 0.5 || wantStance !== 'prone')) {
      if (this.body.setStance(wantStance)) this.stanceCur = wantStance;
    }
    if (this.stanceCur === 'prone' && speed > 0.5) speed = Math.min(speed, 0.9);
    else if (this.stanceCur === 'crouch' && this.slideT <= 0) speed = Math.min(speed, 1.9);
    if (this.slideT > 0) speed = Math.max(speed, 6.5 * (this.slideT / 0.65));
    this.crouch = this.stanceCur !== 'stand';
    this.lean = damp(this.lean, wantLean, 8, dt);

    // ---------------- physics ----------------
    const tv = wish.multiplyScalar(speed);
    this.vel.x = damp(this.vel.x, tv.x, this.slideT > 0 ? 2 : 9, dt);
    this.vel.z = damp(this.vel.z, tv.z, this.slideT > 0 ? 2 : 9, dt);
    if (!this.body.grounded) this.vel.y -= 21 * dt;
    else this.vel.y = Math.max(this.vel.y, -1.5);
    // movement LOD: far, off-screen soldiers run their character-controller sweep at a lower rate
    this.moveAcc += dt;
    const mi = this.w.moveInterval?.(this) ?? 0;
    if (this.moveAcc >= mi) {
      const step = this.moveAcc;
      this.moveAcc = 0;
      const moved = this.body.move(this.sMove.copy(this.vel).multiplyScalar(step), this.vel.y <= 0.1);
      if (this.body.grounded && this.vel.y < 0) this.vel.y = -1.5;
      this.moveSpeed = damp(this.moveSpeed, Math.hypot(moved.x, moved.z) / Math.max(step, 1e-4), 10, step);
    }
    // out of the map: respawn guard
    if (this.body.pos.y < -3 && !inTunnel(this.body.pos.x, this.body.pos.y, this.body.pos.z)) this.health = 0;

    // ---------------- aim ----------------
    let wantYaw = this.vel.lengthSq() > 0.5 ? Math.atan2(-this.vel.x, -this.vel.z) : this.aimYaw;
    let wantPitch = 0;
    let aiming = false;
    if ((this.target && this.lastSeenT < 1.5) || suppressFire) {
      const visibleNow = this.lastSeenT < 0.35 && this.target;
      const aimAt = visibleNow ? this.target!.chest(this.sAim) : this.sAim.copy(this.lastSeen).setY(this.lastSeen.y + 1.25);
      if (visibleNow && this.rng.chance(0.002)) this.target!.eye(aimAt);
      // lead a moving target (better soldiers lead better)
      if (visibleNow) {
        const tvel = velocityOf(this.target!);
        if (tvel) aimAt.addScaledVector(tvel, (aimAt.distanceTo(this.body.pos) / 750) * (1 - sk.lag) + 0.06 * (1 - sk.lag));
      }
      const to = aimAt.sub(this.eye(this.sT1));
      wantYaw = Math.atan2(-to.x, -to.z);
      wantPitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
      aiming = true;
    } else if (this.coverNode && threat && it === 'cover') {
      const to = this.sT1.copy(threat).sub(this.body.pos);
      wantYaw = Math.atan2(-to.x, -to.z);
    } else if (this.heardAt) {
      const to = this.sT1.copy(this.heardAt).sub(this.body.pos);
      wantYaw = Math.atan2(-to.x, -to.z);
    }
    let aimErr = 1;
    if (aiming) {
      const cur = this.aimCur;
      cur.yaw = this.aimYaw;
      cur.pitch = this.aimPitch;
      const tgt = this.target;
      const tv = tgt ? velocityOf(tgt) : null;
      const tdist = tgt ? tgt.position().distanceTo(this.body.pos) : 25;
      const motion = Math.min(2.5, (tv ? Math.hypot(tv.x, tv.z) / 5 : 0) + this.moveSpeed / 6);
      aimErr = this.aimCtl.step(cur, wantYaw, wantPitch, sk, dt, this.stunT > 0 || this.suppression > 0.6, tdist, motion);
      this.aimYaw = cur.yaw;
      this.aimPitch = cur.pitch;
    } else {
      this.aimCtl.yawVel = this.aimCtl.pitchVel = 0;
      this.aimYaw = dampAngle(this.aimYaw, wantYaw, 6 * (this.stunT > 0 ? 0.3 : 1), dt);
      this.aimPitch = damp(this.aimPitch, clamp(wantPitch, -1.2, 1.2), 6, dt);
    }
    const faceAim = it === 'engage' || it === 'cover' || aiming;
    this.yaw = dampAngle(this.yaw, faceAim ? this.aimYaw : wantYaw, this.stanceCur === 'prone' ? 3 : 8, dt);

    // ---------------- shooting ----------------
    this.fireCd -= dt;
    this.reactT -= dt;
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) this.mag = this.def.mag;
    } else if ((visible || suppressFire) && this.reactT <= 0 && (this.target || suppressFire)) {
      const dist = (this.target ? this.target.position() : this.lastSeen).distanceTo(this.body.pos);
      const effRange = this.def.cls === 'Shotgun' ? 26 : this.def.cls === 'SMG' ? 70 : 160;
      // fire when the sights are on: tolerance ~ the target's angular size, a bit looser for
      // spray-and-pray suppressive bursts
      const tol = Math.atan2(suppressFire ? 1.5 : 0.42, dist) + 0.012;
      // when hiding in cover only shoot while peeking
      const hiding = it === 'cover' && this.coverNode && !this.peeking && speed === 0;
      if (this.burstPause > 0) this.burstPause -= dt;
      else if (!hiding && aimErr < tol && dist < effRange && this.fireCd <= 0) {
        if (this.burstLeft <= 0) this.burstLeft = this.def.modes[0] === 'auto' ? this.rng.int(d.burst[0], d.burst[1]) : 1;
        this.shoot(d.spread * (1 + this.suppression * 1.4) * (suppressFire ? 1.8 : 1), dist);
        this.burstLeft--;
        if (this.burstLeft <= 0) this.burstPause = (this.def.modes[0] === 'auto' ? this.rng.range(0.25, 0.7) : this.rng.range(0.2, 0.6)) * (suppressFire ? 2 : 1);
      }
    }

    // ---------------- animation ----------------
    // movement LOD steps the physics at 20–30 Hz for far / off-screen soldiers: between steps the
    // body is drawn dead-reckoned along its velocity so it glides instead of stepping
    const lead = Math.min(this.moveAcc, 0.06);
    if (lead > 0) this.root.position.set(this.body.pos.x + this.vel.x * lead, this.body.pos.y, this.body.pos.z + this.vel.z * lead);
    else this.root.position.copy(this.body.pos);
    this.root.rotation.y = this.yaw + Math.PI; // soldier model faces +Z
    const sp = this.moveSpeed;
    if (this.throwT >= 0) {
      const pd = this.pending;
      // cocked and cooking: hold at the top of the wind-up while the fuse burns
      if (pd && pd.cook > 0 && this.throwT >= 0.52) {
        pd.cook -= dt;
        pd.cooked += dt;
        this.throwT = 0.52;
      } else this.throwT += dt / 1.15;
      if (pd && this.throwT >= 0.61) {
        this.pending = null;
        if (this.alive) {
          if (pd.lethal) this.w.throwGrenade?.(this, pd.at, pd.cooked);
          else this.w.throwTactical?.(this, pd.at, pd.tk);
        }
      }
      if (this.throwT >= 1) this.throwT = -1;
    }
    // animation LOD: full rate near/on screen, reduced for far or off-screen soldiers
    this.animAcc += dt;
    const lod = this.w.animInterval?.(this) ?? 0;
    if (this.animAcc >= lod) {
      this.poseSoldier(this.animAcc);
      this.animAcc = 0;
      this.updateHitbox();
    }
    // footsteps
    if (this.body.grounded && sp > 1) {
      this.stepPhase += (sp * dt) / (sp > 4 ? 1.7 : 1.3);
      if (this.stepPhase > 1) {
        this.stepPhase -= 1;
        this.w.footstep(this.body.pos, sp, this);
      }
    }
    this.lastPos.copy(this.body.pos);
    void now;
  }

  private smoothT = 0;
  private followedPath = false;
  private followPath(wish: THREE.Vector3) {
    // string pulling: skip a waypoint when the next one is in plain view and walkable (no more
    // zig-zagging node to node across open ground)
    this.smoothT -= 1 / 60;
    if (this.path.length > 1 && this.smoothT <= 0) {
      this.smoothT = 0.3;
      const n1 = this.path[1];
      const p = this.body.pos;
      if (Math.abs(n1.y - p.y) < 0.6 && Math.hypot(n1.x - p.x, n1.z - p.z) < 18) {
        const a = this.sT1.set(p.x, p.y + 0.45, p.z), b = this.sT2.set(n1.x, n1.y + 0.45, n1.z);
        if (this.w.physics.lineOfSight(a, b) && this.w.physics.lineOfSight(a.setY(p.y + 1.2), b.setY(n1.y + 1.2))) this.path.shift();
      }
    }
    while (this.path.length) {
      const n = this.path[0];
      const dx = n.x - this.body.pos.x, dz = n.z - this.body.pos.z;
      if (dx * dx + dz * dz < 1.6) {
        this.path.shift();
        continue;
      }
      wish.set(dx, 0, dz).normalize();
      this.followedPath = true;
      if (n.y - this.body.pos.y > 0.8 && this.body.grounded && Math.hypot(dx, dz) < 2.5) this.vel.y = 6;
      return;
    }
  }

  private shoot(spreadDeg: number, dist: number) {
    if (this.mag <= 0) {
      this.reloadT = this.reloadDur = this.def.reload * 1.1;
      return;
    }
    this.mag--;
    this.shots++;
    this.sinceShot = 0;
    const cls = this.def.cls;
    this.aimCtl.kick(cls === 'Sniper' ? 0.07 : cls === 'Shotgun' ? 0.05 : cls === 'Pistol' ? 0.02 : cls === 'Marksman' ? 0.03 : cls === 'LMG' ? 0.009 : 0.012, this.skill());
    this.fireCd = 60 / this.def.rpm * (this.def.modes[0] === 'semi' ? 1.6 : 1);
    if (this.def.modes[0] === 'pump' || this.def.modes[0] === 'bolt') this.fireCd = this.def.cycle! + 0.2;
    const moving = this.moveSpeed > 1 ? 1.3 : 1;
    const sp = (spreadDeg * moving * (this.crouch ? 0.8 : 1) * Math.PI) / 180;
    const eye = this.eye();
    const dir = this.lookDir();
    const pellets = this.def.pellets;
    const muzzle = new THREE.Vector3();
    this.weapon.sockets.muzzle.getWorldPosition(muzzle);
    for (let i = 0; i < pellets; i++) {
      const dd = dir.clone();
      const r = Math.sqrt(Math.random()) * Math.tan(sp + (pellets > 1 ? (this.def.pelletSpread * Math.PI) / 180 : 0));
      const a = Math.random() * Math.PI * 2;
      const right = new THREE.Vector3(Math.cos(this.aimYaw), 0, -Math.sin(this.aimYaw));
      const up = new THREE.Vector3().crossVectors(right, dd).normalize();
      dd.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
      this.w.fire(this, eye, dd, this.def, muzzle);
    }
    this.soldier.anim.fire(this.def.cls === 'Sniper' || this.def.cls === 'Shotgun' ? 1.6 : this.def.cls === 'Pistol' ? 0.6 : 1);
    if (this.mag <= 0) {
      this.reloadT = this.reloadDur = this.def.reload * 1.15;
      this.w.voice?.(this, 'reload');
    }
    void dist;
  }

  private flinchState = { axis: new THREE.Vector3(1, 0, 0), body: 0, head: 0 };
  /** Fill the animation inputs from what the bot is doing and pose the soldier. */
  private poseSoldier(dt: number) {
    const a = this.anim;
    a.vel.copy(this.vel);
    a.vel.y = 0;
    a.yaw = this.yaw;
    a.aimYaw = this.aimYaw;
    a.aimPitch = this.aimPitch;
    a.stance = this.stanceCur === 'prone' ? 2 : this.stanceCur === 'crouch' ? 1 : 0;
    a.sprint = this.moveSpeed > 5.3 && this.state !== 'engage' && this.slideT <= 0;
    a.tactical = false;
    a.slide = this.slideT > 0;
    a.dive = a.ladder = false;
    a.mantle = -1;
    a.air = !this.body.grounded && this.vel.y > 1;
    a.lean = this.lean;
    a.ready = this.state === 'engage' || this.state === 'search' || (this.target !== null && this.lastSeenT < 3);
    a.calm = this.state === 'roam' && !this.target;
    if (this.reloadT > 0) {
      a.action = 'reload';
      a.actionT = THREE.MathUtils.clamp(1 - this.reloadT / this.reloadDur, 0, 1);
    } else if (this.throwT >= 0) {
      const lethal = this.pending ? this.pending.lethal : this.lastThrowLethal;
      a.action = lethal ? 'throw' : 'throwL';
      a.actionT = this.throwT;
    } else {
      a.action = 'none';
      a.actionT = 0;
    }
    a.item = this.throwT >= 0 ? heldCode(this.heldItem, !!this.pending && this.pending.cooked > 0) : 0;
    this.poseFromAnim(dt);
  }

  private lastThrowLethal = true;
  private heldItem = 'frag';
  /** begin the pull-cook-throw (the grenade leaves the hand at the release point) */
  private startThrow(lethal: boolean, at: THREE.Vector3, cook = 0, tk: 'flash' | 'stun' | 'smoke' = this.tacKind) {
    this.throwT = 0;
    this.lastThrowLethal = lethal;
    this.heldItem = lethal ? (this.sticky ? 'sticky' : 'frag') : tk;
    this.pending = { lethal, tk, at, cook, cooked: 0, item: this.heldItem };
    this.w.voice?.(this, lethal ? 'frag' : tk);
  }

  // ---------------------------------------------------------------- night gear
  /** set by the game every frame: is it dark, is the player wearing goggles */
  static nightView = { night: false, nvg: false };
  private gearLight: THREE.Object3D | null = null;
  private static beamGeo: THREE.BufferGeometry | null = null;
  private static beamMat: THREE.ShaderMaterial | null = null;
  private static laserMat: THREE.MeshBasicMaterial | null = null;
  private static glareMat: THREE.SpriteMaterial | null = null;
  /** half the soldiers run a white weapon light, the rest an IR laser only goggles can see */
  private get irGear() {
    return this.id % 2 === 0;
  }
  private updateGearLight() {
    const nv = Bot.nightView;
    const on = nv.night && this.alive && this.root.visible && !this.legsOnly && this.visLod < 2 && (this.irGear ? nv.nvg : true);
    if (!on) {
      if (this.gearLight) this.gearLight.visible = false;
      return;
    }
    if (!this.gearLight) {
      const g = new THREE.Group();
      g.name = 'gearLight';
      Bot.ensureGearMats();
      if (this.irGear) {
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 45, 4, 1, true).rotateX(Math.PI / 2).translate(0, 0, -22.5), Bot.laserMat!);
        g.add(beam);
      } else {
        g.add(new THREE.Mesh(Bot.beamGeo!, Bot.beamMat!));
        const glare = new THREE.Sprite(Bot.glareMat!);
        glare.scale.setScalar(0.16);
        glare.position.z = -0.02;
        g.add(glare);
      }
      g.traverse((o) => {
        o.layers.set(1);
        (o as THREE.Mesh).castShadow = false;
        o.renderOrder = 30;
      });
      (this.weapon.sockets.muzzle ?? this.weapon.root).add(g);
      this.gearLight = g;
    }
    this.gearLight.visible = true;
  }

  /** the night-gear materials (also used by the shader warm-up) */
  static ensureGearMats() {
    Bot.laserMat ??= new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 2.4, 0.9), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    {
      {
        if (!Bot.beamGeo) {
          // open cone from the muzzle: soft along its length and towards its rim
          Bot.beamGeo = new THREE.ConeGeometry(1.5, 11, 18, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -5.5);
          Bot.beamMat = new THREE.ShaderMaterial({
            uniforms: {},
            vertexShader: `varying float vT; varying vec3 vN; varying vec3 vV;
              void main(){ vT = clamp(-position.z / 11.0, 0.0, 1.0); vec4 mv = modelViewMatrix * vec4(position, 1.0);
                vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
            fragmentShader: `varying float vT; varying vec3 vN; varying vec3 vV;
              void main(){ float edge = pow(abs(dot(vN, vV)), 2.0); float a = pow(1.0 - vT, 3.0) * edge * 0.06;
                gl_FragColor = vec4(vec3(1.0, 0.96, 0.88) * a, a); }`,
            transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
          });
          const c = document.createElement('canvas');
          c.width = c.height = 64;
          const x = c.getContext('2d')!;
          const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
          gr.addColorStop(0, 'rgba(255,255,255,1)');
          gr.addColorStop(0.12, 'rgba(255,248,232,0.5)');
          gr.addColorStop(0.4, 'rgba(255,240,220,0.08)');
          gr.addColorStop(1, 'rgba(255,240,220,0)');
          x.fillStyle = gr;
          x.fillRect(0, 0, 64, 64);
          Bot.glareMat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), color: new THREE.Color(2.2, 2.1, 1.9), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
        }
      }
    }
  }
  static gearWarmMeshes() {
    Bot.ensureGearMats();
    return [new THREE.Mesh(Bot.beamGeo!, Bot.beamMat!), new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), Bot.laserMat!), new THREE.Sprite(Bot.glareMat!)];
  }

  /** pose the soldier from `this.anim` (bots, network puppets and killcam replays share this) */
  private poseFromAnim(dt: number) {
    this.updateGearLight();
    this.flinch.update(1 / 60);
    this.headSnap.update(1 / 60);
    const f = this.flinchState;
    f.axis.copy(this.flinchAxis);
    f.body = this.flinch.value;
    f.head = this.headSnap.value;
    this.soldier.setNVG(!!this.w.night?.());
    this.soldier.pose(this.anim, dt, this.root, f, this.legsOnly);
    const ev = this.soldier.takeEvents();
    if (ev && this.w.animEvent) {
      const p = (this.weapon.sockets.magWell ?? this.weapon.root).getWorldPosition(new THREE.Vector3());
      for (const e of ev) this.w.animEvent(this, e, p);
    }
  }

  // ---------------------------------------------------------------- killcam replay
  private rs = new Float32Array(POSE_N);
  /**
   * [x, y, z, yaw, aimYaw, aimPitch, speed, alive, crouch, deathT, ready,
   *  stance, flags (1 sprint 2 tac 4 slide 8 dive 16 ladder 32 mantle 64 air 128 nvg), lean,
   *  action, actionT, vx, vz, vy, 0]
   */
  replayState() {
    const r = this.rs, p = this.body.pos, a = this.anim;
    r[0] = p.x; r[1] = p.y; r[2] = p.z; r[3] = this.yaw; r[4] = this.aimYaw; r[5] = this.aimPitch;
    r[6] = this.moveSpeed; r[7] = this.alive ? 1 : 0; r[8] = this.crouch ? 1 : 0; r[9] = this.deathT; r[10] = a.ready ? 1 : 0;
    r[11] = a.stance;
    r[12] = (a.sprint ? 1 : 0) | (a.tactical ? 2 : 0) | (a.slide ? 4 : 0) | (a.dive ? 8 : 0) | (a.ladder ? 16 : 0) | (a.mantle >= 0 ? 32 : 0) | (a.air ? 64 : 0) | (this.w.night?.() ? 128 : 0);
    r[13] = a.lean; r[14] = actionCode(a.action); r[15] = a.actionT;
    r[16] = this.vel.x; r[17] = this.vel.z; r[18] = this.vel.y; r[19] = a.item;
    return r;
  }
  /** Visual-only state touched by puppet(); saved before a replay and restored after. */
  /**
   * Snapshot-grenade outline: a second draw of the body sharing the skeleton, glowing and drawn
   * through walls. Built on first use; 0 hides it.
   */
  private revealMeshes: THREE.SkinnedMesh[] | null = null;
  private static revealMat: THREE.ShaderMaterial | null = null;
  setReveal(k: number) {
    if (k <= 0 && !this.revealMeshes) return;
    if (!this.revealMeshes) {
      Bot.revealMat ??= new THREE.ShaderMaterial({
        uniforms: { uK: { value: 1 } },
        vertexShader: `#include <common>
          #include <skinning_pars_vertex>
          varying float vF;
          void main(){
            #include <skinbase_vertex>
            #include <begin_vertex>
            #include <beginnormal_vertex>
            #include <skinnormal_vertex>
            #include <skinning_vertex>
            vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
            vec3 n = normalize(normalMatrix * objectNormal);
            vF = 1.0 - abs(dot(n, normalize(-mv.xyz)));
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `uniform float uK; varying float vF;
          void main(){ float a = (0.18 + pow(vF, 2.0) * 0.9) * uK; gl_FragColor = vec4(vec3(1.6, 0.25, 0.12) * a, a); }`,
        transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      this.revealMeshes = [];
      const src: THREE.SkinnedMesh[] = [];
      this.model.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) src.push(o as THREE.SkinnedMesh);
      });
      for (const m of src) {
        const r = new THREE.SkinnedMesh(m.geometry, Bot.revealMat);
        r.bind(m.skeleton, m.bindMatrix);
        r.renderOrder = 50;
        r.frustumCulled = false;
        r.visible = false;
        r.layers.set(1);
        m.parent!.add(r);
        r.position.copy(m.position);
        r.quaternion.copy(m.quaternion);
        r.scale.copy(m.scale);
        this.revealMeshes.push(r);
      }
    }
    const on = k > 0 && !this.legsOnly;
    for (const r of this.revealMeshes) r.visible = on;
    if (on) Bot.revealMat!.uniforms.uK.value = k;
  }

  saveVisual() {
    return {
      rp: this.root.position.clone(), rr: this.root.rotation.y, rv: this.root.visible, mq: this.model.quaternion.clone(), my: this.model.position.y,
      wv: this.weapon.root.visible, yaw: this.yaw, ay: this.aimYaw, ap: this.aimPitch, ms: this.moveSpeed, dt: this.deathT, rt: this.respawnT, cr: this.crouch,
    };
  }
  restoreVisual(v: ReturnType<Bot['saveVisual']>) {
    this.root.position.copy(v.rp); this.root.rotation.y = v.rr; this.root.visible = v.rv; this.model.quaternion.copy(v.mq); this.model.position.y = v.my;
    this.weapon.root.visible = v.wv; this.yaw = v.yaw; this.aimYaw = v.ay; this.aimPitch = v.ap; this.moveSpeed = v.ms; this.deathT = v.dt; this.respawnT = v.rt; this.crouch = v.cr;
  }
  /** First-person body: keep only hips and legs (the upper body is collapsed into the spine). */
  legsOnly = false;
  makeLegsOnly() {
    this.legsOnly = true;
    for (const n of ['Spine1', 'Spine2', 'Neck', 'Head']) this.bones[n]?.scale.setScalar(0.0001);
    this.weapon.root.visible = false;
    this.soldier.setLod(0);
    this.soldier.mesh.castShadow = true;
  }

  /** Pose the model from a recorded / replicated state (no AI, no physics). */
  puppet(s: ArrayLike<number>, dt: number) {
    const alive = s[7] > 0.5;
    this.root.position.set(s[0], s[1], s[2]);
    this.root.visible = s[1] > -50 && (alive || s[9] < 6);
    if (!this.root.visible) return;
    this.yaw = s[3];
    this.aimYaw = s[4];
    this.aimPitch = s[5];
    this.moveSpeed = s[6];
    this.crouch = s[8] > 0.5;
    this.root.rotation.y = this.yaw + Math.PI;
    if (!alive) {
      if (this.ragdollOn && this.ragdoll) {
        this.ragdoll.apply(this.root, this.model);
        return;
      }
      this.deathT = Math.max(0, s[9] - dt);
      this.updateDeath(dt);
      return;
    }
    this.model.quaternion.identity();
    this.model.position.set(0, 0, 0);
    this.weapon.root.visible = !this.legsOnly;
    const a = this.anim, fl = s[12] | 0;
    if (s.length >= POSE_N) {
      a.vel.set(s[16], 0, s[17]);
      a.stance = s[11];
      a.sprint = !!(fl & 1); a.tactical = !!(fl & 2); a.slide = !!(fl & 4); a.dive = !!(fl & 8); a.ladder = !!(fl & 16);
      a.mantle = fl & 32 ? 0.5 : -1; a.air = !!(fl & 64);
      a.vel.y = s[18];
      a.lean = s[13];
      a.action = ACTIONS[s[14] | 0] ?? 'none';
      a.actionT = s[15];
      a.item = s[19] | 0;
    } else {
      // older 11-value recordings: velocity from speed along the facing
      a.vel.set(-Math.sin(this.yaw) * s[6], 0, -Math.cos(this.yaw) * s[6]);
      a.stance = this.crouch ? 1 : 0;
      a.action = 'none';
    }
    a.yaw = this.yaw; a.aimYaw = this.aimYaw; a.aimPitch = this.aimPitch;
    a.ready = s[10] > 0.5;
    a.calm = !a.ready;
    this.root.updateMatrixWorld(true);
    this.poseFromAnim(dt);
  }

  /** move this soldier to the other side (network roster changes): camo, gear colours, armbands */
  setTeam(t: 0 | 1) {
    this.team = t;
    this.soldier.setTeam(t);
  }
  /** hide until the owner's first state arrives */
  netHide() {
    NETF.allowPuppetDeath++;
    this.alive = false;
    NETF.allowPuppetDeath--;
    this.state = 'dead';
    this.deathT = 99;
    this.respawnT = 1e9;
    this.root.visible = false;
    this.body.setEnabled(false);
    this.netTarget = null;
  }

  // ---------------------------------------------------------------- network puppet
  /** latest replicated state [x, y, z, yaw, aimYaw, aimPitch, speed, alive, crouch, deathT, engaging] */
  /**
   * A replicated pose with the time it was taken (this machine's clock: the sender's timestamp
   * mapped through the measured clock offset). Kept in a short buffer and drawn ~100 ms in the
   * past, *between* two real snapshots (snapshot interpolation) — smooth and exact instead of
   * chasing the latest one; briefly extrapolated along the velocity if packets are late.
   */
  netState(s: ArrayLike<number>, t = performance.now() / 1000) {
    const buf = this.netBuf;
    // drop a sample older than the newest (unreliable channel: out of order)
    if (buf.length && t <= buf[buf.length - 1].t) {
      if (t < buf[buf.length - 1].t - 0.5) buf.length = 0; // a clock reset (rejoin / migration)
      else return;
    }
    const e = this.netPool.pop() ?? { t: 0, s: new Float32Array(POSE_N) };
    e.t = t;
    e.s.set(s as ArrayLike<number>);
    buf.push(e);
    while (buf.length > 12) this.netPool.push(buf.shift()!);
    if (!this.netTarget) {
      this.netTarget = new Float32Array(POSE_N);
      this.netCur.set(e.s);
    }
    this.netTarget.set(e.s);
  }
  private netBuf: { t: number; s: Float32Array }[] = [];
  private netPool: { t: number; s: Float32Array }[] = [];
  /** render time for interpolated puppets (set by the network layer each frame) */
  static netRenderT = 0;
  /** sample the buffer at time t into out (false: nothing yet) */
  private netSample(t: number, out: Float32Array) {
    const b = this.netBuf;
    if (!b.length) return false;
    if (t <= b[0].t) {
      out.set(b[0].s);
      return true;
    }
    let i = 1;
    while (i < b.length && b[i].t < t) i++;
    if (i >= b.length) {
      // starved: extrapolate the newest along its velocity, at most 250 ms
      const last = b[b.length - 1];
      out.set(last.s);
      const ex = Math.min(0.25, t - last.t);
      out[0] += last.s[16] * ex;
      out[2] += last.s[17] * ex;
      return true;
    }
    const A = b[i - 1], B = b[i];
    const k = (t - A.t) / Math.max(1e-4, B.t - A.t);
    // teleports (respawn): snap
    const jump = Math.hypot(B.s[0] - A.s[0], B.s[2] - A.s[2]) > 6;
    for (let j = 0; j < POSE_N; j++) {
      const a = A.s[j], c = B.s[j];
      if (jump || j === 7 || j === 8 || j === 10 || j === 11 || j === 12 || j === 14) out[j] = k < 0.5 && !jump ? a : c;
      else if (j === 3 || j === 4) out[j] = a + wrapAngle(c - a) * k;
      else out[j] = a + (c - a) * k;
    }
    return true;
  }
  /** this slot is now (or no longer) owned elsewhere */
  setPuppet(v: boolean) {
    this.netPuppet = v;
    this.netTarget = null;
    this.netBuf.length = 0;
    if (v) {
      this.target = null;
      this.path = [];
    }
  }
  /** a death the owner decided (ragdoll along `dir`) */
  netKill(dir: THREE.Vector3, part: HitPart) {
    if (!this._alive) return;
    this.lastHitPart = part;
    NETF.allowPuppetDeath++;
    try {
      this._health = 0;
      this.kill(dir);
    } finally {
      NETF.allowPuppetDeath--;
    }
  }
  /** pose from the network, smoothing toward the latest snapshot */
  netUpdate(dt: number) {
    const s = this.netTarget;
    if (!s) {
      if (!this._alive) this.updateDeath(dt);
      return;
    }
    const alive = s[7] > 0.5;
    if (alive && !this._alive) {
      // respawned on its owner's machine
      this._alive = true;
      this.spawn(new THREE.Vector3(s[0], s[1], s[2]), s[3]);
      this.netCur.set(s);
    }
    if (!this._alive) {
      if (!alive) {
        this.updateDeath(dt);
        return;
      }
    }
    if (!alive) {
      // the owner says dead but the death event has not arrived yet: give it a moment
      this.netDeadT += dt;
      if (this.netDeadT > 0.6) this.netKill(new THREE.Vector3(Math.sin(s[3]), 0, Math.cos(s[3])), 'body');
    } else this.netDeadT = 0;
    const c = this.netCur;
    if (!this.netSample(Bot.netRenderT || performance.now() / 1000 - 0.1, c)) c.set(s);
    c[7] = 1;
    c[9] = 0;
    this.body.teleport(this.sT1.set(c[0], c[1], c[2]));
    this.vel.set(c[16], c[18], c[17]);
    this.puppet(c, dt);
    this.updateHitbox();
  }

  private updateDeath(dt: number) {
    this.deathT += dt;
    this.respawnT -= dt;
    if (this.ragdollOn && this.ragdoll) {
      this.ragdoll.update(dt);
      this.ragdoll.apply(this.root, this.model);
      if (this.deathT > 0.25) this.weapon.root.visible = false;
      if (this.deathT > 6) this.root.visible = false;
      return;
    }
    if (this.deathT < 2.5) {
      const crumple = this.deathStyle === 1;
      const delay = crumple ? 0.28 : 0;
      const raw = clamp((this.deathT - delay) / (crumple ? 0.55 : 0.7), 0, 1);
      const t = raw * raw * (crumple ? 1 : 0.6) + easeOutCubic(raw) * (crumple ? 0 : 0.4); // gravity-like acceleration
      const bounce = Math.sin(clamp((this.deathT - delay - (crumple ? 0.5 : 0.65)) / 0.25, 0, 1) * Math.PI) * 0.07;
      const axisLocal = this.fallAxis.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.root.rotation.y);
      const q = new THREE.Quaternion().setFromAxisAngle(axisLocal, (Math.PI / 2) * (t - bounce) * 0.97);
      if (this.deathSpin) q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.deathSpin * easeOutCubic(raw)));
      this.model.quaternion.copy(q);
      // knees buckle first on a crumple
      const sag = crumple ? clamp(this.deathT / 0.3, 0, 1) * (1 - raw) * 0.55 : 0;
      this.model.position.y = lerp(0, -0.05, t) - sag;
      if (this.deathT > 0.3) this.weapon.root.visible = false;
    }
    if (this.deathT > 6) this.root.visible = false;
  }
}

// ---------------------------------------------------------------- helpers
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();

function rotateBoneWorld(bone: THREE.Object3D, axisWorld: THREE.Vector3, angle: number) {
  if (Math.abs(angle) < 1e-5) return;
  const parent = bone.parent!;
  parent.getWorldQuaternion(_q);
  bone.getWorldQuaternion(_q2);
  const delta = new THREE.Quaternion().setFromAxisAngle(axisWorld.clone().normalize(), angle);
  const world = delta.multiply(_q2);
  bone.quaternion.copy(_q.invert().multiply(world));
  bone.updateMatrixWorld(true);
}

/** Point a bone's child-direction at a world target. */
function aimBone(bone: THREE.Object3D, child: THREE.Object3D, target: THREE.Vector3) {
  const bp = bone.getWorldPosition(new THREE.Vector3());
  const cp = child.getWorldPosition(_v);
  const cur = cp.sub(bp).normalize();
  const want = target.clone().sub(bp).normalize();
  const delta = new THREE.Quaternion().setFromUnitVectors(cur, want);
  const parent = bone.parent!;
  parent.getWorldQuaternion(_q);
  bone.getWorldQuaternion(_q2);
  bone.quaternion.copy(_q.invert().multiply(delta.multiply(_q2)));
  bone.updateMatrixWorld(true);
}

function solveTwoBone(upper: THREE.Object3D, fore: THREE.Object3D, hand: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3) {
  const s = upper.getWorldPosition(new THREE.Vector3());
  const e = fore.getWorldPosition(new THREE.Vector3());
  const h = hand.getWorldPosition(new THREE.Vector3());
  const a = s.distanceTo(e), b = e.distanceTo(h);
  const toT = target.clone().sub(s);
  let d = toT.length();
  const dir = toT.divideScalar(Math.max(d, 1e-5));
  d = Math.min(d, (a + b) * 0.999);
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const perp = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
  const elbow = s.clone().addScaledVector(dir, a * cosA).addScaledVector(perp, a * sinA);
  aimBone(upper, fore, elbow);
  aimBone(fore, hand, s.clone().addScaledVector(dir, d));
}

export function raySphere(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, r: number): number | null {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
}

export function rayCapsule(o: THREE.Vector3, d: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number): number | null {
  // closest approach between ray and segment, then sphere test at that segment point
  const ab = b.clone().sub(a);
  const ao = o.clone().sub(a);
  const abab = ab.dot(ab), abd = ab.dot(d), abao = ab.dot(ao), dao = d.dot(ao);
  const denom = abab - abd * abd;
  const s = denom > 1e-6 ? clamp((abao - abd * dao) / denom, 0, 1) : 0;
  const p = a.clone().addScaledVector(ab, s);
  return raySphere(o, d, p, r);
}
