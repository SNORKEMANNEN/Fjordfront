import * as THREE from 'three';
import { NETF } from '../net/NetFlags';
import { bakeFlat } from '../render/Batch';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CharacterBody } from '../player/CharacterBody';
import { Physics } from '../core/Physics';
import { NavGraph } from './NavGraph';
import { WeaponDef, WEAPONS } from '../weapons/WeaponDefs';
import { WeaponModel } from '../weapons/WeaponModels';
import { clamp, damp, dampAngle, lerp, RNG, wrapAngle, easeOutCubic, Spring } from '../core/math';
import { Combatant, HitPart } from '../game/Combatant';
import { Ragdoll } from './Ragdoll';

export interface BotAsset {
  scene: THREE.Object3D;
  clips: THREE.AnimationClip[];
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
  private netCur = new Float32Array(11);
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
  mixer: THREE.AnimationMixer;
  actions: Record<string, THREE.AnimationAction> = {};
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
  private moveSpeed = 0;
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
  armband: THREE.Mesh[] = [];
  gunMesh: THREE.Mesh | null = null;
  visibleToPlayer = false;

  constructor(public id: number, public name: string, public team: 0 | 1, asset: BotAsset, weaponModel: WeaponModel, defId: keyof typeof WEAPONS, private w: BotWorld, teamMat: THREE.Material) {
    this.rng = new RNG(id * 7919 + 13);
    this.tacKind = (['flash', 'stun', 'smoke'] as const)[id % 3];
    this.def = WEAPONS[defId];
    this.body = new CharacterBody(w.physics, new THREE.Vector3(0, -100, 0));
    this.model = cloneSkinned(asset.scene);
    this.model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        // cullable with a fixed, generous sphere (bind pose ×1.8: covers crouch, aim, ragdoll
        // flail) instead of never culled — 24 soldiers behind you were still two draws each
        if ((m as THREE.SkinnedMesh).isSkinnedMesh) {
          m.geometry.computeBoundingSphere();
          m.boundingSphere = m.geometry.boundingSphere!.clone();
          m.boundingSphere.radius *= 1.8;
          m.frustumCulled = true;
        } else m.frustumCulled = false;
        if (m.name.includes('vanguard_Mesh')) m.material = teamMat;
      }
      if ((o as THREE.Bone).isBone) this.bones[o.name.replace('mixamorig', '').replace(':', '')] = o as THREE.Bone;
    });
    this.root.add(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);
    for (const c of asset.clips) {
      const a = this.mixer.clipAction(c);
      a.play();
      a.setEffectiveWeight(c.name === 'Idle' ? 1 : 0);
      this.actions[c.name] = a;
    }
    this.weapon = weaponModel;
    this.weapon.root.scale.setScalar(1);
    this.root.add(this.weapon.root);
    this.weapon.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    // third-person guns never animate their parts: bake ~25 meshes (5-7 materials, lens shaders)
    // into ONE vertex-coloured mesh — one draw + one shadow draw per bot gun
    this.gunMesh = bakeFlat(this.weapon.root, 'botgun');
    // team armbands on both upper arms
    const bandGeo = new THREE.CylinderGeometry(6.2, 6.2, 5, 10, 1, true);
    const bandMat = new THREE.MeshStandardMaterial({ color: team === 0 ? 0x2a6ad8 : 0xc8281c, emissive: team === 0 ? 0x0a1a40 : 0x400806, roughness: 0.6, side: THREE.DoubleSide });
    for (const bn of ['LeftArm', 'RightArm']) {
      const b = this.bones[bn];
      if (!b) continue;
      const m = new THREE.Mesh(bandGeo, bandMat);
      m.position.y = 12;
      m.castShadow = false;
      b.add(m);
      this.armband.push(m);
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
  /** Render LOD by camera distance: shadows only near, armbands only where they can be read. */
  visualLod(d: number) {
    const lv = d < 32 ? 0 : d < 60 ? 1 : 2;
    if (lv === this.visLod) return;
    this.visLod = lv;
    const shadow = lv === 0;
    this.model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) (o as THREE.Mesh).castShadow = shadow;
    });
    if (this.gunMesh) this.gunMesh.castShadow = d < 22;
    for (const a of this.armband) a.visible = lv < 2 && !this.legsOnly;
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
  }

  hitTest(o: THREE.Vector3, d: THREE.Vector3, max: number): { dist: number; part: HitPart; point: THREE.Vector3 } | null {
    if (!this.alive) return null;
    // broad phase
    const c = this.chest();
    const toC = c.clone().sub(o);
    const t = toC.dot(d);
    if (t < 0 || t > max + 2) return null;
    if (toC.clone().addScaledVector(d, -t).lengthSq() > 2.5) return null;
    const h = this.hitbox;
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
    return { dist: bb.dist, part: bb.part, point: o.clone().addScaledVector(d, bb.dist) };
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
      this.actions.Run?.setEffectiveWeight(0);
      this.actions.Walk?.setEffectiveWeight(0);
      this.actions.Idle?.setEffectiveWeight(1);
      this.mixer.update(dt * 0.4);
      this.root.position.copy(this.body.pos);
      this.root.rotation.y = this.yaw + Math.PI;
      this.poseUpperBody();
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
    const wish = new THREE.Vector3();
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
      const to = tp.clone().sub(this.body.pos).setY(0).normalize();
      const side = new THREE.Vector3(-to.z, 0, to.x);
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
        this.w.voice?.(this, 'frag');
        this.w.throwGrenade?.(this, this.lastSeen.clone());
      } else if (this.tacticals > 0 && d > 7 && d < 26 && this.tacKind !== 'smoke' && this.rng.chance(0.5)) {
        // flash / stun the room before pushing it
        this.tacticals--;
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
      const moved = this.body.move(this.vel.clone().multiplyScalar(step), this.vel.y <= 0.1);
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
      const aimAt = visibleNow ? this.target.chest(new THREE.Vector3()) : this.lastSeen.clone().setY(this.lastSeen.y + 1.25);
      if (this.rng.chance(0.002)) aimAt.copy(this.target.eye(new THREE.Vector3()));
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
    const wRun = clamp((sp - 3.2) / 2.0, 0, 1);
    const wWalk = clamp(sp / 2.0, 0, 1) * (1 - wRun);
    const wIdle = 1 - Math.max(wRun, wWalk);
    this.actions.Run?.setEffectiveWeight(wRun);
    this.actions.Walk?.setEffectiveWeight(wWalk);
    this.actions.Idle?.setEffectiveWeight(wIdle);
    if (this.actions.Run) this.actions.Run.timeScale = clamp(sp / 5.2, 0.7, 1.3);
    if (this.actions.Walk) this.actions.Walk.timeScale = clamp(sp / 1.6, 0.6, 1.6);
    // animation LOD: full rate near/on screen, reduced for far or off-screen soldiers
    this.animAcc += dt;
    const lod = this.w.animInterval?.(this) ?? 0;
    if (this.animAcc >= lod) {
      this.mixer.update(this.animAcc);
      this.animAcc = 0;
      if (this.crouch) this.model.position.y = damp(this.model.position.y, -0.45, 10, dt);
      else this.model.position.y = damp(this.model.position.y, 0, 10, dt);
      this.poseUpperBody();
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
      this.reloadT = this.def.reload * 1.1;
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
    if (this.mag <= 0) {
      this.reloadT = this.def.reload * 1.15;
      this.w.voice?.(this, 'reload');
    }
    void dist;
  }

  /** Aim the spine, place the weapon in front of the chest and IK both arms onto it. */
  private poseUpperBody() {
    const b = this.bones;
    this.model.updateMatrixWorld(true);
    const pitch = this.aimPitch;
    const yawRel = wrapAngle(this.aimYaw - this.yaw);
    const right = new THREE.Vector3(Math.cos(this.aimYaw), 0, -Math.sin(this.aimYaw));
    for (const n of ['Spine', 'Spine1', 'Spine2']) {
      const bone = b[n];
      if (!bone) continue;
      rotateBoneWorld(bone, new THREE.Vector3(0, 1, 0), yawRel / 3);
      rotateBoneWorld(bone, right, -pitch / 3);
    }
    // keep chest upright relative to running lean (only the spine subtree moved: arms, head and
    // the weapon hang off it, the legs did not change)
    (b.Spine ?? this.model).updateMatrixWorld(true);
    const chest = new THREE.Vector3();
    (b.Spine2 ?? b.Spine).getWorldPosition(chest);
    const aim = this.lookDir();
    const up = new THREE.Vector3().crossVectors(right, aim).normalize();
    const g = this.weapon.root;
    const gp = chest.clone().addScaledVector(aim, 0.3).addScaledVector(right, 0.13).addScaledVector(up, 0.03);
    g.position.copy(gp).sub(this.root.position);
    g.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.root.rotation.y);
    g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, aim.clone().negate()));
    g.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -this.root.rotation.y));
    g.updateMatrixWorld(true);
    const rt = new THREE.Vector3(), lt = new THREE.Vector3();
    this.weapon.sockets.rightHand.getWorldPosition(rt);
    this.weapon.sockets.leftHand.getWorldPosition(lt);
    if (b.RightArm && b.RightForeArm && b.RightHand) solveTwoBone(b.RightArm, b.RightForeArm, b.RightHand, rt, right.clone().multiplyScalar(0.7).add(new THREE.Vector3(0, -1, 0)));
    if (b.LeftArm && b.LeftForeArm && b.LeftHand) solveTwoBone(b.LeftArm, b.LeftForeArm, b.LeftHand, lt, right.clone().multiplyScalar(-0.8).add(new THREE.Vector3(0, -1, 0)));
    if (b.Head) rotateBoneWorld(b.Head, right, -pitch * 0.3);
    // hit reactions on top of the aim pose
    this.flinch.update(1 / 60);
    this.headSnap.update(1 / 60);
    if (Math.abs(this.flinch.value) > 1e-3) {
      if (b.Spine1) rotateBoneWorld(b.Spine1, this.flinchAxis, this.flinch.value * 0.12);
      if (b.Spine2) rotateBoneWorld(b.Spine2, this.flinchAxis, this.flinch.value * 0.16);
    }
    if (b.Head && Math.abs(this.headSnap.value) > 1e-3) rotateBoneWorld(b.Head, this.flinchAxis, this.headSnap.value * 0.08);
  }

  // ---------------------------------------------------------------- killcam replay
  private rs = new Float32Array(11);
  /** [x, y, z, yaw, aimYaw, aimPitch, speed, alive, crouch, deathT, engaging] */
  replayState() {
    const r = this.rs, p = this.body.pos;
    r[0] = p.x; r[1] = p.y; r[2] = p.z; r[3] = this.yaw; r[4] = this.aimYaw; r[5] = this.aimPitch;
    r[6] = this.moveSpeed; r[7] = this.alive ? 1 : 0; r[8] = this.crouch ? 1 : 0; r[9] = this.deathT; r[10] = this.state === 'engage' ? 1 : 0;
    return r;
  }
  /** Visual-only state touched by puppet(); saved before a replay and restored after. */
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
    for (const n of ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head']) this.bones[n]?.scale.setScalar(0.0001);
    this.weapon.root.visible = false;
    for (const a of this.armband) a.visible = false;
    this.model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
    });
  }

  /** Pose the model from a recorded state (no AI, no physics). */
  puppet(s: Float32Array, dt: number) {
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
    this.weapon.root.visible = !this.legsOnly;
    const sp = this.moveSpeed;
    const wRun = clamp((sp - 3.2) / 2.0, 0, 1);
    const wWalk = clamp(sp / 2.0, 0, 1) * (1 - wRun);
    this.actions.Run?.setEffectiveWeight(wRun);
    this.actions.Walk?.setEffectiveWeight(wWalk);
    this.actions.Idle?.setEffectiveWeight(1 - Math.max(wRun, wWalk));
    this.mixer.update(dt);
    this.model.position.y = this.crouch ? -0.45 : 0;
    this.root.updateMatrixWorld(true);
    if (!this.legsOnly) this.poseUpperBody();
  }

  /** move this soldier to the other side (network roster changes): uniform + armbands */
  setTeam(t: 0 | 1, uniform: THREE.Material) {
    this.team = t;
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.name.includes('vanguard_Mesh')) m.material = uniform;
    });
    const band = this.armband[0]?.material as THREE.MeshStandardMaterial | undefined;
    if (band) {
      band.color.set(t === 0 ? 0x2a6ad8 : 0xc8281c);
      band.emissive.set(t === 0 ? 0x0a1a40 : 0x400806);
    }
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
      this.netTarget = new Float32Array(11);
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
    for (const i of [0, 1, 2, 5, 6, 8]) c[i] = far ? s[i] : c[i] + (s[i] - c[i]) * k;
    for (const i of [3, 4]) c[i] = c[i] + wrapAngle(s[i] - c[i]) * (far ? 1 : k);
    c[7] = 1;
    c[9] = 0;
    c[10] = s[10];
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
      this.mixer.update(dt * (1 - t) * 0.5);
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
