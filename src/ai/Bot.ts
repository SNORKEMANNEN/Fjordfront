import * as THREE from 'three';
import { NETF } from '../net/NetFlags';
import { bakeFlat, bakeProxy } from '../render/Batch';
import { Soldier } from '../character/Soldier';
import { roleFor, SoldierLook } from '../character/SoldierMesh';
import { AnimState, ActionKind, newAnimState, ReloadStyle } from '../character/SoldierAnim';
import { CharacterBody } from '../player/CharacterBody';
import { Physics } from '../core/Physics';
import { NavGraph } from './NavGraph';
import { WeaponDef, WEAPONS } from '../weapons/WeaponDefs';
import { WeaponModel } from '../weapons/WeaponModels';
import { clamp, damp, dampAngle, lerp, RNG, wrapAngle, easeOutCubic, Spring } from '../core/math';
import { Combatant, HitPart } from '../game/Combatant';
import { Ragdoll } from './Ragdoll';

/** replicated / recorded pose: see Bot.replayState */
export const POSE_N = 20;
const ACTIONS: ActionKind[] = ['none', 'reload', 'throw', 'melee', 'knife', 'switch', 'bolt', 'plant'];
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
  /** how far soldiers can see right now (fog / snowstorm shrink it) */
  viewDist?(): number;
  callout?: (from: Bot, enemyPos: THREE.Vector3) => void;
  /** lob a frag at a position (bots carry one per life) */
  throwGrenade?(bot: Bot, at: THREE.Vector3): void;
  /** throw a tactical (flash / stun / smoke) */
  throwTactical?(bot: Bot, at: THREE.Vector3, kind: 'flash' | 'stun' | 'smoke'): void;
  /** smoke between two points blocks sight */
  smokeBlocks?(a: THREE.Vector3, b: THREE.Vector3): boolean;
  /** radio chatter: "Reloading!", "Frag out!" ... */
  voice?(bot: Bot, line: string): void;
  difficulty: number; // 0..1
}

const DIFF = [
  { reaction: 0.7, spread: 1.9, aimSpeed: 3.5, burst: [2, 4] },
  { reaction: 0.45, spread: 1.15, aimSpeed: 5.5, burst: [3, 6] },
  { reaction: 0.28, spread: 0.65, aimSpeed: 8.0, burst: [4, 8] },
];

type State = 'roam' | 'engage' | 'search' | 'cover' | 'dead';

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
      this.flinch.impulse(clamp(amount / 25, 0.3, 2.2) * 3.2 * (part === 'limb' ? 0.5 : 1));
      if (part === 'head') this.headSnap.impulse(9);
      this.vel.addScaledVector(h, clamp(amount / 30, 0.2, 1.4) * 1.6);
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
      if (this.health < 45 && this.rng.chance(0.5)) this.seekCover(from.position());
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
    if (!this.alive || this.state === 'cover') return;
    const away = this.body.pos.clone().sub(from).setY(0);
    if (away.lengthSq() < 0.01) away.set(this.rng.range(-1, 1), 0, this.rng.range(-1, 1));
    away.setLength(11);
    const goal = this.w.nav.nearest(this.body.pos.clone().add(away), 12)?.p ?? this.body.pos.clone().add(away);
    this.path = this.w.nav.path(this.body.pos, goal) ?? [goal.clone()];
    this.goal.copy(goal);
    this.state = 'cover';
    this.repathT = 3;
  }

  hear(p: THREE.Vector3) {
    if (!this.alive || this.state === 'engage') return;
    this.heardAt = p.clone();
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
  private seekCover(threat: THREE.Vector3) {
    const here = this.body.pos;
    let best: THREE.Vector3 | null = null;
    let bs = -Infinity;
    for (const n of this.w.nav.near(here, 22)) {
      if (n.links.length === 0) continue;
      const vis = this.w.physics.lineOfSight(n.p.clone().setY(n.p.y + 1.3), threat.clone().setY(threat.y + 1.4));
      const s = (vis ? -10 : 10) - n.p.distanceTo(here) * 0.3 - n.cover * 3;
      if (s > bs) {
        bs = s;
        best = n.p;
      }
    }
    if (best) {
      this.path = this.w.nav.path(here, best) ?? [];
      this.state = 'cover';
      this.repathT = 3;
    }
  }

  private perceive() {
    if (this.blindT > 0) return;
    const eye = this.eye();
    const fwd = this.lookDir();
    let bestT: Combatant | null = null;
    let bd = Infinity;
    for (const c of this.w.combatants()) {
      if (c.team === this.team || !c.alive) continue;
      const cp = c.chest(new THREE.Vector3());
      const to = cp.clone().sub(eye);
      const dist = to.length();
      if (dist > (this.w.viewDist?.() ?? 160)) continue;
      to.divideScalar(dist);
      const inFov = to.dot(fwd) > Math.cos((dist < 10 ? 140 : 70) * (Math.PI / 180));
      const noticed = inFov || dist < 6 || (c === this.lastAttacker && this.lastDamageT < 3);
      if (!noticed) continue;
      // crouched/prone targets in vegetation are harder to see far away
      if (dist > 70 && (c as any).isPlayer && (c as any).stealth > 0.5 && this.rng.chance(0.6)) continue;
      const head = c.eye(new THREE.Vector3());
      if (!this.w.physics.lineOfSight(eye, cp) && !this.w.physics.lineOfSight(eye, head)) continue;
      if (this.w.smokeBlocks?.(eye, cp)) continue;
      const score = dist * (c === this.target ? 0.6 : 1) * (c === this.lastAttacker ? 0.5 : 1);
      if (score < bd) {
        bd = score;
        bestT = c;
      }
    }
    if (bestT) {
      if ((bestT !== this.target || this.lastSeenT > 4) && this.rng.chance(0.45)) this.w.voice?.(this, 'contact');
      if (bestT !== this.target || this.lastSeenT > 1.0) {
        const d = DIFF[Math.round(this.w.difficulty * 2)];
        this.reactT = d.reaction * this.rng.range(0.75, 1.35) * (this.state === 'engage' ? 0.6 : 1);
        const errScale = 1 + bd / 40;
        this.aimErr.set(this.rng.range(-1, 1) * 0.06 * errScale, this.rng.range(-1, 1) * 0.05 * errScale);
      }
      this.target = bestT;
      this.lastSeen.copy(bestT.position());
      this.lastSeenT = 0;
      this.w.callout?.(this, bestT.position());
      this.state = this.state === 'cover' && this.path.length ? 'cover' : 'engage';
    }
  }

  private pickGoal() {
    // objective players (Domination capture/defend) often ignore distant noise and keep to the flag
    if (this.heardAt && this.w.preferObjective?.(this) && this.rng.chance(0.85)) this.heardAt = null;
    const g = this.heardAt ?? (this.lastSeenT < 8 && !(this.w.preferObjective?.(this) && this.rng.chance(0.4)) ? this.lastSeen : this.w.objectiveFor(this.team, this.body.pos, this));
    this.heardAt = null;
    this.goal.copy(g);
    this.path = this.w.nav.path(this.body.pos, this.goal, 6000, this.w.pathOpts?.(this) ?? {}) ?? [];
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
    this.perceiveT -= dt;
    if (this.perceiveT <= 0) {
      this.perceiveT = 0.18 + this.rng.range(0, 0.08);
      this.perceive();
    }
    if (this.target && (!this.target.alive || this.lastSeenT > 2.5)) {
      if (!this.target.alive) this.lastSeenT = 99;
      this.target = null;
      this.state = this.lastSeenT < 8 ? 'search' : 'roam';
      if (this.state === 'search') {
        this.path = this.w.nav.path(this.body.pos, this.lastSeen) ?? [];
        this.repathT = 6;
      }
    }
    const d = DIFF[Math.round(this.w.difficulty * 2)];
    const visible = this.target && this.lastSeenT < 0.35;

    // ---------------- movement intent ----------------
    const wish = this.sWish.set(0, 0, 0);
    let speed = 0;
    if (this.state === 'engage' && this.target) {
      const tp = this.target.position();
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
      // objective players keep pushing to the flag while trading shots at range
      const pushObj = visible && dist > 22 && this.w.preferObjective?.(this) && this.goal.distanceTo(this.body.pos) > 3;
      if (pushObj) {
        if (!this.path.length || this.repathT <= 0) {
          this.path = this.w.nav.path(this.body.pos, this.goal, 6000, this.w.pathOpts?.(this) ?? {}) ?? [];
          this.repathT = 3;
        }
        this.followPath(wish);
        wish.multiplyScalar(0.85).addScaledVector(side, this.strafeDir * 0.3);
      } else wish.addScaledVector(side, this.strafeDir);
      if (dist > ideal + 12 && visible) wish.addScaledVector(to, 0.9);
      else if (dist < ideal * 0.5) wish.addScaledVector(to, -0.6);
      if (!visible) {
        // lost sight briefly: push toward last known position
        if (!this.path.length || this.repathT <= 0) {
          this.path = this.w.nav.path(this.body.pos, this.lastSeen) ?? [];
          this.repathT = 2;
        }
        this.followPath(wish);
      }
      speed = visible ? (this.crouch ? 1.8 : pushObj ? 3.6 : 3.2) : 5.0;
    } else {
      this.repathT -= dt;
      const atGoal = this.body.pos.distanceTo(this.goal) < 2.2;
      if (atGoal && this.dwellT < 0 && (this.state === 'roam' || this.w.preferObjective?.(this))) this.dwellT = this.w.dwellAt?.(this.goal, this) ?? 0;
      if (this.dwellT > 0) {
        // hold the room: stand, sweep the view around
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
      }
      else if (this.repathT <= 0) {
        // periodic re-plan toward the SAME goal (keeps mission itineraries intact)
        const np = this.w.nav.path(this.body.pos, this.goal, 6000, this.w.pathOpts?.(this) ?? {});
        if (np && np.length) this.path = np;
        else this.pickGoal();
        this.repathT = 4 + this.rng.range(0, 2);
      }
      this.followPath(wish);
      speed = this.state === 'search' ? 4.8 : this.state === 'cover' ? 6.4 : 6.0;
      if (this.state === 'cover' && !this.path.length) this.state = this.target ? 'engage' : 'roam';
    }
    this.repathT -= dt;
    // frag the corner the enemy just ducked behind
    this.nadeCd -= dt;
    if (this.state === 'engage' && this.target && this.frags > 0 && this.nadeCd <= 0 && this.lastSeenT > 0.7 && this.lastSeenT < 5) {
      const d = this.lastSeen.distanceTo(this.body.pos);
      this.nadeCd = 6 + this.rng.range(0, 8);
      if (d > 9 && d < 32 && this.rng.chance(0.55)) {
        this.frags--;
        this.throwT = 0;
        this.w.voice?.(this, 'frag');
        this.w.throwGrenade?.(this, this.lastSeen.clone());
      } else if (this.tacticals > 0 && d > 7 && d < 26 && this.tacKind !== 'smoke' && this.rng.chance(0.5)) {
        // flash / stun the room before pushing it
        this.tacticals--;
        this.throwT = 0;
        this.w.voice?.(this, this.tacKind);
        this.w.throwTactical?.(this, this.lastSeen.clone(), this.tacKind);
      }
    }
    // smoke to cover a retreat or a push across open ground
    if (this.tacKind === 'smoke' && this.tacticals > 0 && this.target && this.health < 60 && this.lastSeenT < 0.4) {
      const d = this.target.position().distanceTo(this.body.pos);
      if (d > 18 && this.rng.chance(0.02)) {
        this.tacticals--;
        this.w.voice?.(this, 'smoke');
        this.w.throwTactical?.(this, this.body.pos.clone().lerp(this.target.position(), 0.35), 'smoke');
      }
    }
    // status effects
    this.blindT = Math.max(0, this.blindT - dt);
    this.stunT = Math.max(0, this.stunT - dt);
    if (this.blindT > 0) {
      // staggering, shielding the eyes
      wish.set(Math.sin(now * 1.3 + this.id), 0, Math.cos(now * 0.9 + this.id)).multiplyScalar(0.4);
      speed = 1.3;
      this.burstPause = Math.max(this.burstPause, 0.3);
    }
    if (this.stunT > 0) speed *= 0.45;
    if (wish.lengthSq() > 1) wish.normalize();
    this.wantCrouchT -= dt;
    const wantCrouch = this.state === 'engage' && this.wantCrouchT > 0 && this.def.cls !== 'Shotgun';
    if (wantCrouch !== this.crouch) {
      if (this.body.setStance(wantCrouch ? 'crouch' : 'stand')) this.crouch = wantCrouch;
    }
    if (this.crouch) speed = Math.min(speed, 1.8);

    // ---------------- physics ----------------
    const tv = wish.multiplyScalar(speed);
    this.vel.x = damp(this.vel.x, tv.x, 9, dt);
    this.vel.z = damp(this.vel.z, tv.z, 9, dt);
    if (!this.body.grounded) this.vel.y -= 21 * dt;
    else this.vel.y = Math.max(this.vel.y, -1.5);
    // movement LOD: far, off-screen soldiers run their character-controller sweep at half rate
    this.moveAcc += dt;
    const mi = this.w.moveInterval?.(this) ?? 0;
    if (this.moveAcc >= mi) {
      const step = this.moveAcc;
      this.moveAcc = 0;
      const moved = this.body.move(this.sMove.copy(this.vel).multiplyScalar(step), this.vel.y <= 0.1);
      if (this.body.grounded && this.vel.y < 0) this.vel.y = -1.5;
      this.moveSpeed = damp(this.moveSpeed, Math.hypot(moved.x, moved.z) / Math.max(step, 1e-4), 10, step);
    }
    // stuck detection → hop & repath
    if (tv.lengthSq() > 1 && this.moveSpeed < 0.4) {
      this.stuckT += dt;
      if (this.stuckT > 0.8 && this.body.grounded) {
        this.vel.y = 6.2;
        this.stuckT = 0;
        this.stuckHops++;
        this.path.shift();
        if (this.rng.chance(0.5)) this.repathT = 0;
      }
    } else this.stuckT = 0;
    // out of the map: respawn guard
    if (this.body.pos.y < -3) this.health = 0;

    // ---------------- aim ----------------
    let wantYaw = this.vel.lengthSq() > 0.5 ? Math.atan2(-this.vel.x, -this.vel.z) : this.aimYaw;
    let wantPitch = 0;
    if (this.target && this.lastSeenT < 1.5) {
      const visibleNow = this.lastSeenT < 0.35;
      const aimAt = visibleNow ? this.target.chest(this.sAim) : this.sAim.copy(this.lastSeen).setY(this.lastSeen.y + 1.25);
      if (this.rng.chance(0.002)) this.target.eye(aimAt);
      const to = aimAt.sub(this.eye());
      wantYaw = Math.atan2(-to.x, -to.z) + this.aimErr.x;
      wantPitch = Math.atan2(to.y, Math.hypot(to.x, to.z)) + this.aimErr.y;
      this.aimErr.multiplyScalar(Math.exp(-dt * 2.6));
    } else if (this.heardAt) {
      const to = this.heardAt.clone().sub(this.body.pos);
      wantYaw = Math.atan2(-to.x, -to.z);
    }
    const aimK = this.stunT > 0 ? 0.3 : 1;
    this.aimYaw = dampAngle(this.aimYaw, wantYaw, (this.target ? d.aimSpeed : 6) * aimK, dt);
    this.aimPitch = damp(this.aimPitch, clamp(wantPitch, -1.2, 1.2), d.aimSpeed * aimK, dt);
    this.yaw = dampAngle(this.yaw, this.state === 'engage' ? this.aimYaw : wantYaw, 8, dt);

    // ---------------- shooting ----------------
    this.fireCd -= dt;
    this.reactT -= dt;
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) this.mag = this.def.mag;
    } else if (visible && this.reactT <= 0 && this.target) {
      const yawErr = Math.abs(wrapAngle(this.aimYaw - wantYaw));
      const dist = this.target.position().distanceTo(this.body.pos);
      const effRange = this.def.cls === 'Shotgun' ? 26 : this.def.cls === 'SMG' ? 70 : 160;
      if (this.burstPause > 0) this.burstPause -= dt;
      else if (yawErr < 0.12 && dist < effRange && this.fireCd <= 0) {
        if (this.burstLeft <= 0) this.burstLeft = this.def.modes[0] === 'auto' ? this.rng.int(d.burst[0], d.burst[1]) : 1;
        this.shoot(d.spread, dist);
        this.burstLeft--;
        if (this.burstLeft <= 0) this.burstPause = this.def.modes[0] === 'auto' ? this.rng.range(0.25, 0.7) : this.rng.range(0.2, 0.6);
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
      this.throwT += dt / 0.9;
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

  private followPath(wish: THREE.Vector3) {
    while (this.path.length) {
      const n = this.path[0];
      const dx = n.x - this.body.pos.x, dz = n.z - this.body.pos.z;
      if (dx * dx + dz * dz < 1.6) {
        this.path.shift();
        continue;
      }
      wish.set(dx, 0, dz).normalize();
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
    a.stance = this.crouch ? 1 : 0;
    a.sprint = this.moveSpeed > 5.3 && this.state !== 'engage';
    a.tactical = false;
    a.slide = a.dive = a.ladder = false;
    a.mantle = -1;
    a.air = !this.body.grounded && this.vel.y > 1;
    a.lean = 0;
    a.ready = this.state === 'engage' || this.state === 'search' || (this.target !== null && this.lastSeenT < 3);
    a.calm = this.state === 'roam' && !this.target;
    if (this.reloadT > 0) {
      a.action = 'reload';
      a.actionT = THREE.MathUtils.clamp(1 - this.reloadT / this.reloadDur, 0, 1);
    } else if (this.throwT >= 0) {
      a.action = 'throw';
      a.actionT = this.throwT;
    } else {
      a.action = 'none';
      a.actionT = 0;
    }
    this.poseFromAnim(dt);
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
    r[16] = this.vel.x; r[17] = this.vel.z; r[18] = this.vel.y; r[19] = 0;
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
  netState(s: ArrayLike<number>) {
    if (!this.netTarget) {
      this.netTarget = new Float32Array(POSE_N);
      this.netTarget.set(s as ArrayLike<number>);
      this.netCur.set(this.netTarget);
    } else this.netTarget.set(s as ArrayLike<number>);
  }
  /** this slot is now (or no longer) owned elsewhere */
  setPuppet(v: boolean) {
    this.netPuppet = v;
    this.netTarget = null;
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
    const k = 1 - Math.exp(-dt * 14);
    const far = Math.hypot(s[0] - c[0], s[2] - c[2]) > 6;
    for (const i of SMOOTH_I) c[i] = far ? s[i] : c[i] + (s[i] - c[i]) * k;
    for (const i of [3, 4]) c[i] = c[i] + wrapAngle(s[i] - c[i]) * (far ? 1 : k);
    c[7] = 1;
    c[9] = 0;
    for (const i of COPY_I) c[i] = s[i];
    this.body.teleport(new THREE.Vector3(c[0], c[1], c[2]));
    this.vel.set((s[0] - c[0]) * 10, 0, (s[2] - c[2]) * 10);
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
const SMOOTH_I = [0, 1, 2, 5, 6, 8, 11, 13, 15, 16, 17, 18];
const COPY_I = [10, 12, 14];
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
