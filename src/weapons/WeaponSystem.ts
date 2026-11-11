import * as THREE from 'three';
import { planBreak } from './BreakAction';
import { DB_W } from './WeaponModels';
import { reportError } from '../core/ErrorReport';
import { WEAPONS, WeaponDef, FireMode } from './WeaponDefs';
import { WEAPON_BUILDERS, WeaponId, WeaponMats, WeaponModel } from './WeaponModels';
import { aimKick, viewKick, settleRate } from './Recoil';
import { Viewmodel, VMContext } from './Viewmodel';
import { Input } from '../core/Input';
import { PlayerController } from '../player/PlayerController';
import { CameraRig } from '../player/CameraRig';
import { MuzzleFlash } from '../fx/Effects';
import { clamp, damp } from '../core/math';
import { Settings } from '../game/Settings';

export interface WeaponState {
  def: WeaponDef;
  model: WeaponModel;
  mag: number;
  reserve: number;
  mode: FireMode;
  chambered: boolean; // pump/bolt need cycling
}

export interface ShotRequest {
  def: WeaponDef;
  origin: THREE.Vector3;
  dirs: THREE.Vector3[];
  muzzleScreen: THREE.Vector3; // NDC of muzzle in viewmodel camera
  ejectScreen: THREE.Vector3;
  tracer: boolean;
}

export interface WeaponHooks {
  onShot(req: ShotRequest): void;
  onSound(name: string, def: WeaponDef): void;
  onDryFire(def: WeaponDef): void;
  /** knife attack pressed: 'slash' (fire) or 'stab' (aim). Returns true if the game started a takedown. */
  onKnife?(kind: 'slash' | 'stab'): boolean;
}

export class WeaponSystem {
  slots: WeaponState[] = [];
  current = 0;
  vm: Viewmodel;
  ads = 0;
  private adsHeld = false;
  get adsWanted() {
    return this.adsHeld;
  }
  private cooldown = 0;
  private burstCount = 0;
  private shotsInSpray = 0;
  private sinceShot = 10;
  private pendingRecoil = new THREE.Vector2();
  private sprayRecoil = new THREE.Vector2();
  private burstLeft = 0;
  private recoverRecoil = new THREE.Vector2();
  bloom = 0;
  sprintBlock = 0; // time until we may fire after sprint
  switching = false;
  reloading = false;
  private shellsToLoad = 0;
  private reloadInterrupt = false;
  private wantFire = false;
  flash: MuzzleFlash;
  firing = false;
  private sprintBlend = 0;
  private tacBlend = 0;
  private slideBlend = 0;
  private crouchBlend = 0;
  private airBlend = 0;
  scopeActive = false;
  enabled = true;
  /** debug/testing: force viewmodel context values (e.g. { tactical: 1 }) */
  vmForce: Partial<VMContext> | null = null;
  /** set by the game: 1 while night vision is down on a gun with an IR laser (canted aim) */
  cant = 0;
  /** set by the game: signed door-peek lean amount */
  peek = 0;
  /** set by the game: LMG bipod deployed (prone, or mounted on a ledge) */
  bipod = 0;
  /** set by the game: signed Q/E lean amount -1..1 */
  lean = 0;
  lastSpread = 0;
  private cycleTimer = 0;
  private adsSoundOn = false;

  constructor(
    private input: Input,
    private player: PlayerController,
    private rig: CameraRig,
    vm: Viewmodel,
    private mats: WeaponMats,
    private hooks: WeaponHooks,
    muzzleTex: THREE.Texture,
    private vmCamera: THREE.PerspectiveCamera,
  ) {
    this.vm = vm;
    this.flash = new MuzzleFlash(muzzleTex);
    vm.onEvent = (n) => this.hooks.onSound(n, this.cur.def);
  }

  get cur() {
    return this.current === 2 && this.knife ? this.knife : this.slots[this.current];
  }
  /** dedicated melee: not part of the two-gun loadout, equipped by holding [V] */
  knife: WeaponState | null = null;
  get knifeOut() {
    return this.current === 2;
  }
  private lastGun = 0;
  private slashSide = 1;
  equipKnife() {
    if (this.current === 2 || this.switching) return;
    if (!this.knife) {
      const def = WEAPONS.knife;
      this.knife = { def, model: WEAPON_BUILDERS.knife(this.mats), mag: 0, reserve: 0, mode: 'semi', chambered: true };
    }
    this.lastGun = this.current;
    this.switchTo(2);
  }

  setLoadout(ids: WeaponId[]) {
    if (this.slots.length === ids.length && ids.every((id, i) => this.slots[i].def.id === id)) {
      this.refill();
      this.equip(0, true);
      return;
    }
    for (const s of this.slots) s.model.root.removeFromParent();
    this.slots = ids.map((id) => {
      const def = WEAPONS[id];
      const model = WEAPON_BUILDERS[id](this.mats);
      return { def, model, mag: def.mag, reserve: def.reserve, mode: def.modes[0], chambered: true };
    });
    this.current = 0;
    this.equip(0, true);
  }

  refill() {
    for (const s of this.slots) {
      s.mag = s.def.mag;
      s.reserve = s.def.reserve;
      s.chambered = true;
    }
    this.vm.boltLocked = false;
  }

  private equip(i: number, instant = false) {
    this.current = i;
    const s = this.cur;
    this.vm.setWeapon(s.model, s.def);
    s.model.sockets.muzzle.add(this.flash.group);
    this.reloading = false;
    this.vm.boltLocked = s.mag === 0 && (s.def.cls === 'Pistol' || s.def.cls === 'Assault Rifle' || s.def.cls === 'SMG' || s.def.cls === 'Marksman');
    this.vm.bipod = 0;
    this.bipod = 0;
    this.switching = true;
    this.vm.play('draw', instant ? 0.5 : 0.24 + s.def.weight * 0.17, [[0.0, 'draw']], () => (this.switching = false));
  }

  switchTo(i: number) {
    if (i === this.current || (i >= this.slots.length && !(i === 2 && this.knife)) || this.switching) return;
    this.switching = true;
    this.reloading = false;
    this.cycleTimer = 0;
    this.vm.play('holster', 0.12 + this.cur.def.weight * 0.08, [[0, 'holster']], () => this.equip(i));
  }

  private startReload() {
    const s = this.cur;
    if (s.def.cls === 'Melee') return;
    if (this.reloading || this.switching || s.reserve <= 0 || s.mag >= s.def.mag) return;
    const d = s.def;
    if (d.action === 'break') {
      // break action: the reload is planned from the chamber state (one or both fired)
      const plan = planBreak(s.mag, d.mag, s.reserve);
      if (!plan.slots.length) return;
      this.reloading = true;
      const n = plan.slots.length;
      this.vm.play('breakReload', n === 2 ? d.reloadEmpty : d.reload, [[0.0, 'reloadStart']], () => {
        s.mag += n;
        s.reserve -= n;
        s.chambered = true;
        this.reloading = false;
      }, plan);
      return;
    }
    this.reloading = true;
    if (d.perShell) {
      // shotgun: shell by shell
      this.shellsToLoad = Math.min(d.mag - s.mag, s.reserve);
      const wasEmpty = s.mag === 0;
      this.reloadInterrupt = false;
      this.vm.play('shellStart', 0.32, [], () => this.loadShell(wasEmpty));
      return;
    }
    const empty = s.mag === 0;
    const dur = empty ? d.reloadEmpty : d.reload;
    // detailed foley events are emitted by the authored reload in Viewmodel.animateReload
    const ev: [number, string][] = [[0.0, 'reloadStart']];
    this.vm.play(empty ? 'reloadEmpty' : 'reload', dur, ev, () => {
      const need = d.mag - s.mag;
      const take = Math.min(need, s.reserve);
      s.mag += take;
      s.reserve -= take;
      s.chambered = true;
      this.reloading = false;
      this.vm.boltLocked = false;
    });
  }

  private loadShell(wasEmpty: boolean) {
    const s = this.cur;
    if (this.reloadInterrupt || this.shellsToLoad <= 0 || s.reserve <= 0 || s.mag >= s.def.mag) {
      this.vm.play('shellEnd', wasEmpty ? 0.55 : 0.3, wasEmpty ? [[0.3, 'pumpBack'], [0.62, 'pumpForward']] : [], () => {
        this.reloading = false;
        s.chambered = true;
      }, { pump: wasEmpty });
      return;
    }
    this.vm.play('shell', s.def.perShell!, [[0.6, 'shellIn']], () => {
      s.mag++;
      s.reserve--;
      this.shellsToLoad--;
      this.loadShell(wasEmpty);
    });
  }

  private cycleAction() {
    const s = this.cur;
    const d = s.def;
    if (d.modes[0] === 'pump') {
      this.vm.play('pump', d.cycle!, [[0.05, 'pumpBack'], [0.5, 'eject'], [0.62, 'pumpForward']], () => (s.chambered = true));
    } else if (d.modes[0] === 'bolt') {
      this.vm.play('bolt', d.cycle!, [[0.12, 'boltOpen'], [0.34, 'boltBack'], [0.45, 'eject'], [0.62, 'boltClose']], () => (s.chambered = true));
    }
  }

  update(dt: number, indoor: number) {
    const inp = this.input;
    const p = this.player;
    const s = this.cur;
    if (!s) return;
    const d = s.def;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.sinceShot += dt;
    if (this.cycleTimer > 0) {
      this.cycleTimer -= dt;
      if (this.cycleTimer <= 0 && !this.reloading && !this.switching && !s.chambered) {
        // pump / bolt waits for a one-handed action (stim, UAV) to finish instead of cutting it off
        const t = this.vm.action?.type;
        if (t === 'stim' || t === 'uav') this.cycleTimer = 1e-4;
        else this.cycleAction();
      }
    }

    if (this.enabled) {
      // ---- switching ----
      if (inp.wasPressed('primary')) this.switchTo(0);
      if (inp.wasPressed('secondary')) this.switchTo(1);
      if (inp.wasPressed('swap') || inp.wheel !== 0) this.switchTo(this.current === 2 ? this.lastGun : this.current === 0 ? 1 : 0);
      if (inp.wasPressed('fireMode') && d.modes.length > 1) {
        const i = d.modes.indexOf(s.mode);
        s.mode = d.modes[(i + 1) % d.modes.length];
        this.hooks.onSound('fireMode', d);
      }
      if (inp.wasPressed('reload')) this.startReload();
      // tap = full inspect, hold = magazine / chamber check
      if (inp.wasPressed('inspect')) this.inspectHeld = 0;
      if (inp.isDown('inspect') && this.inspectHeld >= 0 && d.cls !== 'LMG') {
        this.inspectHeld += dt;
        if (this.inspectHeld > 0.28 && !this.vm.action && !this.reloading) {
          this.inspectHeld = -1;
          this.vm.play('inspectMag', d.cls === 'Pistol' ? 1.6 : d.cls === 'Sniper' || d.cls === 'Marksman' ? 1.8 : 2.0, [[0.05, 'cloth']]);
        }
      }
      if (inp.wasReleased('inspect') && this.inspectHeld >= 0) {
        this.inspectHeld = -1;
        const dur = ({ LMG: 4.2, 'Assault Rifle': 3.6, SMG: 3.0, Pistol: 3.0, Shotgun: 3.4, Sniper: 3.6, Marksman: 3.6, Melee: 2.4 } as Record<string, number>)[d.cls] ?? 3.2;
        if (!this.vm.action && !this.reloading) this.vm.play('inspect', dur, [[0.06, 'inspect1'], [0.45, 'inspect2']]);
      }
    }

    // ---- knife: no ADS, no ammo; fire = slash (alternating), aim = stab ----
    if (d.cls === 'Melee') {
      this.ads = Math.max(0, this.ads - dt * 6);
      p.ads = this.ads;
      p.adsSpeedMul = 1;
      p.weaponSpeedMul = d.speedMul;
      this.scopeActive = false;
      const slash = this.enabled && inp.wasPressed('fire');
      const stab = this.enabled && inp.wasPressed('ads');
      if ((slash || stab) && !this.switching && !p.mantle && (!this.vm.action || this.vm.action.type === 'inspect')) {
        p.sprinting = false;
        p.tactical = false;
        const kind = stab ? 'stab' : 'slash';
        if (!this.hooks.onKnife?.(kind)) {
          this.slashSide = -this.slashSide;
          if (kind === 'slash') this.vm.play('knifeSlash', 0.46, [[0.2, 'swish'], [0.34, 'knifeSwing']], undefined, { side: this.slashSide });
          else this.vm.play('knifeStab', 0.5, [[0.26, 'swish'], [0.38, 'knifeSwing']]);
        }
      }
    }

    // ---- ADS ----
    if (Settings.data.toggleAds) {
      if (inp.wasPressed('ads')) this.adsHeld = !this.adsHeld;
    } else this.adsHeld = inp.isDown('ads');
    const busy = this.switching || (this.reloading && !d.perShell);
    const cycling = this.vm.action?.type === 'bolt';
    const handsBusy = !!this.vm.action && ['throw', 'stim', 'uav', 'designate', 'melee', 'nvg'].includes(this.vm.action.type);
    const wantAds = d.cls !== 'Melee' && this.enabled && this.adsHeld && !busy && !handsBusy && !p.sprinting && !p.mantle && !(p.sliding && d.cls === 'Sniper');
    if (wantAds && p.sprinting) p.sprinting = false;
    if (this.adsHeld && p.sprinting && !busy) {
      p.sprinting = false;
      p.tactical = false;
    }
    const adsTarget = wantAds ? (cycling ? 0.55 : 1) : 0;
    if (adsTarget > 0.5 && !this.adsSoundOn) {
      this.adsSoundOn = true;
      this.hooks.onSound('adsIn', d);
    } else if (adsTarget < 0.5 && this.adsSoundOn) {
      this.adsSoundOn = false;
      this.hooks.onSound('adsOut', d);
    }
    const rate = 1 / d.adsTime;
    this.ads = adsTarget > this.ads ? Math.min(adsTarget, this.ads + rate * dt) : Math.max(adsTarget, this.ads - rate * 1.25 * dt);
    p.ads = this.ads;
    p.adsSpeedMul = d.adsSpeedMul;
    p.weaponSpeedMul = d.speedMul;
    this.scopeActive = !!d.scope && this.ads > 0.92;

    // ---- blends for viewmodel ----
    this.sprintBlend = damp(this.sprintBlend, p.sprinting && !p.sliding ? 1 : 0, p.sprinting ? 9 : 12, dt);
    this.tacBlend = damp(this.tacBlend, p.tactical ? 1 : 0, 8, dt);
    this.slideBlend = damp(this.slideBlend, p.sliding ? 1 : 0, 10, dt);
    this.crouchBlend = damp(this.crouchBlend, p.stance === 'crouch' || p.stance === 'prone' ? 1 : 0, 8, dt);
    this.airBlend = damp(this.airBlend, p.grounded ? 0 : 1, 8, dt);
    if (p.sprinting) this.sprintBlock = d.sprintToFire * (p.tactical ? 1.4 : 1);
    else this.sprintBlock = Math.max(0, this.sprintBlock - dt);

    // ---- firing ----
    const trig = this.enabled && inp.isDown('fire');
    const trigPressed = this.enabled && inp.wasPressed('fire');
    if (trigPressed) this.wantFire = true;
    if (!trig && s.mode !== 'auto') this.wantFire = this.wantFire && this.cooldown > 0 ? this.wantFire : false;
    this.firing = false;
    if (trig && (p.sprinting || p.tactical)) {
      // firing input cancels sprint (CoD-style)
      p.sprinting = false;
      p.tactical = false;
    }
    if (trigPressed && d.perShell && this.reloading) {
      this.reloadInterrupt = true;
    }
    // stim and the UAV tablet are one-handed: the right hand keeps shooting
    const oneHand = !!this.vm.action && (this.vm.action.type === 'stim' || this.vm.action.type === 'uav');
    const canFire = d.cls !== 'Melee' && !this.switching && !this.reloading && this.sprintBlock <= 0 && this.cooldown <= 0 && !p.mantle && (this.vm.action === null || this.vm.action.type === 'inspect' || oneHand);
    if (canFire && ((s.mode === 'auto' && trig) || this.wantFire) && this.vm.action && (this.vm.action.type === 'inspect')) this.vm.cancelAction();
    // 3-round burst: one pull fires three at a raised cyclic, then a short reset
    if (s.mode === 'burst' && this.wantFire && this.burstLeft === 0 && canFire && s.mag > 0) {
      this.burstLeft = 3;
      this.wantFire = false;
    }
    if (this.burstLeft > 0 && canFire && s.mag > 0 && s.chambered) {
      this.fire(s);
      this.burstLeft--;
      this.cooldown = this.burstLeft > 0 ? 60 / (d.rpm * 1.25) : 0.2;
    } else if (this.burstLeft > 0 && (s.mag === 0 || this.reloading || this.switching)) this.burstLeft = 0;
    if (s.mode !== 'burst' && canFire && ((s.mode === 'auto' && trig) || this.wantFire)) {
      if (s.mag > 0 && s.chambered) {
        this.fire(s);
        this.wantFire = false;
      } else if (trigPressed) {
        this.hooks.onDryFire(d);
        this.wantFire = false;
        if (s.mag === 0 && s.reserve > 0) this.startReload();
      }
    }
    if (!trig) this.burstCount = 0;
    // auto reload when empty after a short beat
    if (d.cls !== 'Melee' && s.mag === 0 && !this.reloading && this.sinceShot > 0.35 && s.reserve > 0 && !this.switching && !this.vm.action) this.startReload();

    // ---- recoil application & recovery ----
    const apply = 1 - Math.exp(-34 * dt);
    const ax = this.pendingRecoil.x * apply, ay = this.pendingRecoil.y * apply;
    this.pendingRecoil.x -= ax;
    this.pendingRecoil.y -= ay;
    p.addRecoil(ax, ay);
    this.sprayRecoil.x += ax;
    this.sprayRecoil.y += ay;
    if (this.sinceShot <= 60 / d.rpm + 0.06 && this.shotsInSpray > 3) {
      // recoil that settles: during a sustained spray the muscles fight the climb, so part of it
      // bleeds back continuously and the climb plateaus instead of walking off the target
      const k = settleRate(d) * dt * Math.min(1, (this.shotsInSpray - 3) / 6);
      const sx = this.sprayRecoil.x * k, sy = this.sprayRecoil.y * k;
      this.sprayRecoil.x -= sx;
      this.sprayRecoil.y -= sy;
      p.addRecoil(-sx, -sy);
    }
    if (this.sinceShot > 60 / d.rpm + 0.06) {
      // recover part of the climb smoothly
      if (this.sprayRecoil.lengthSq() > 1e-8) {
        this.recoverRecoil.x += this.sprayRecoil.x * d.recoil.recover;
        this.recoverRecoil.y += this.sprayRecoil.y * d.recoil.recover;
        this.sprayRecoil.set(0, 0);
      }
      this.shotsInSpray = 0;
    }
    if (this.recoverRecoil.lengthSq() > 1e-9) {
      // eased: a short hold right after the trigger is released, then it glides back
      const k = 1 - Math.exp(-(this.sinceShot < 0.14 ? 3 : 8.5) * dt);
      const rx = this.recoverRecoil.x * k, ry = this.recoverRecoil.y * k;
      this.recoverRecoil.x -= rx;
      this.recoverRecoil.y -= ry;
      p.addRecoil(-rx, -ry);
    }
    // cancel recovery if the player actively pulls down
    if (p.lookDY > 0.002) this.recoverRecoil.multiplyScalar(0.6);

    this.bloom = Math.max(0, this.bloom - dt * (this.sinceShot > 0.15 ? 5 : 1.5));

    // ---- viewmodel ----
    const right = new THREE.Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
    const ctx: VMContext = {
      ads: this.ads,
      sprint: this.sprintBlend,
      tactical: this.tacBlend,
      slide: this.slideBlend,
      crouch: this.crouchBlend,
      air: this.airBlend,
      speed01: p.speed01,
      stepPhase: p.stepPhase,
      foot: p.lastFoot,
      lookDX: p.lookDX,
      lookDY: p.lookDY,
      strafe: p.vel.dot(right),
      vy: p.vel.y,
      indoor,
      firing: this.firing || (trig && this.sinceShot < 0.12),
      ladder: p.ladder ? 1 : 0,
      climb: p.pos.y,
      mantle: p.mantle ? Math.min(1, p.mantle.t) : -1,
      vault: !!p.mantle?.vault,
      cant: this.cant,
      peek: this.peek,
      lean: this.lean,
    };
    // the dive tucks the gun like a slide
    this.diveBlend = damp(this.diveBlend, p.diving ? 1 : 0, p.diving ? 10 : 4, dt);
    ctx.slide = Math.max(ctx.slide, this.diveBlend);
    if (this.vmForce) Object.assign(ctx, this.vmForce);
    this.vm.bipod = this.bipod;
    this.vm.sprayShake = this.sinceShot < 0.12 && s.mode === 'auto' ? Math.min(1, this.shotsInSpray / 9) : 0;
    try {
      this.vm.update(dt, ctx);
    } catch (e) {
      // never let an animation bug freeze the game: drop the action, finish a reload, report it
      reportError('viewmodel', e);
      const wasReload = this.reloading;
      this.vm.cancelAction();
      this.switching = false;
      if (wasReload) {
        const take = Math.min(s.def.mag - s.mag, s.reserve);
        s.mag += take;
        s.reserve -= take;
        s.chambered = true;
        this.reloading = false;
        this.vm.boltLocked = false;
      }
    }
    this.flash.update(dt);
    this.vm.root.visible = true;
    // ---- scope sway & hold breath ----
    this.updateBreath(dt, d.scope ? this.ads : 0);
  }

  private inspectHeld = -1;
  private diveBlend = 0;
  breath = 1; // 1 = full lungs, 0 = exhausted
  holdingBreath = false;
  private swayT = 0;
  private swayPrev = new THREE.Vector2();
  private exhausted = 0;
  /** Scoped weapons sway with breathing; holding sprint steadies the aim for a few seconds. */
  private updateBreath(dt: number, scoped: number) {
    const p = this.player;
    const want = scoped > 0.9 && this.input.isDown('sprint') && this.breath > 0.02 && this.exhausted <= 0;
    if (want && !this.holdingBreath) this.hooks.onSound('breathIn', this.cur.def);
    if (!want && this.holdingBreath) this.hooks.onSound('breathOut', this.cur.def);
    this.holdingBreath = want;
    if (want) {
      this.breath = Math.max(0, this.breath - dt / 4.5);
      if (this.breath <= 0) this.exhausted = 2.5;
    } else this.breath = Math.min(1, this.breath + dt / 3);
    this.exhausted = Math.max(0, this.exhausted - dt);
    const amp = 0.0042 * scoped * (want ? 0.04 : this.exhausted > 0 ? 2.2 : 1) * (p.stance === 'prone' ? 0.35 : p.stance === 'crouch' ? 0.7 : 1);
    this.swayT += dt * (this.exhausted > 0 ? 1.8 : 1);
    const t = this.swayT;
    const now = new THREE.Vector2(Math.sin(t * 0.83) * 1.0 + Math.sin(t * 1.9) * 0.3, Math.sin(t * 1.21 + 0.7) * 0.7 + Math.sin(t * 2.6) * 0.2).multiplyScalar(amp);
    const dlt = now.clone().sub(this.swayPrev);
    this.swayPrev.copy(now);
    p.addRecoil(dlt.y, dlt.x);
  }

  /** Current spread cone in degrees. */
  spread() {
    const p = this.player;
    const d = this.cur.def;
    const move = clamp(p.horizSpeed() / 5, 0, 1.6);
    let sp = d.hipSpread + d.moveSpread * move + this.bloom;
    sp = sp * (1 - this.ads) + (d.adsSpread + d.adsSpread * move * 2 + this.bloom * 0.15) * this.ads;
    if (p.stance === 'crouch') sp *= 0.78;
    if (p.stance === 'prone') sp *= 0.55;
    // trigger discipline: semi on a full-auto gun is tighter, bursts sit between
    const m = this.cur.mode;
    if (d.modes.includes('auto') && m === 'semi') sp *= 0.8;
    else if (m === 'burst') sp *= 0.88;
    if (!p.grounded) sp *= 2.2;
    if (p.sliding) sp *= 1.4;
    if (this.bipod > 0) sp *= 1 - 0.45 * this.bipod;
    this.lastSpread = sp;
    return sp;
  }

  private fire(s: WeaponState) {
    const d = s.def;
    const p = this.player;
    s.mag--;
    if (s.mag > 0 && s.mag <= Math.ceil(d.mag * 0.25) && d.mag > 5) this.hooks.onSound('lowAmmo', d);
    this.cooldown = 60 / d.rpm;
    this.sinceShot = 0;
    this.burstCount++;
    this.shotsInSpray++;
    this.firing = true;
    if (d.modes[0] === 'pump' || d.modes[0] === 'bolt') s.chambered = false;

    // directions
    const spreadDeg = this.spread();
    const cam = this.rig.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const rt = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const cone = (deg: number) => {
      const r = Math.sqrt(Math.random()) * Math.tan((deg * Math.PI) / 180);
      const a = Math.random() * Math.PI * 2;
      return fwd.clone().addScaledVector(rt, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
    };
    const dirs: THREE.Vector3[] = [];
    const base = cone(spreadDeg);
    if (d.pellets > 1) {
      for (let i = 0; i < d.pellets; i++) {
        const r = Math.sqrt(Math.random()) * Math.tan((d.pelletSpread * (this.ads > 0.5 ? 0.8 : 1) * Math.PI) / 180);
        const a = Math.random() * Math.PI * 2;
        dirs.push(base.clone().addScaledVector(rt, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize());
      }
    } else dirs.push(base);
    this.bloom = Math.min(d.bloomMax, this.bloom + d.bloomPerShot);

    // camera recoil (pattern: climbs, drifts with weapon-specific bias)
    const r = d.recoil;
    const stanceMul = (p.stance === 'crouch' ? 0.8 : p.stance === 'prone' ? 0.6 : 1) * (d.modes.includes('auto') && s.mode === 'semi' ? 0.85 : s.mode === 'burst' ? 0.8 : 1) * (1 - 0.5 * this.bipod);
    const first = this.shotsInSpray === 1 ? r.firstShotMul : 1;
    const adsMul = 1 + (r.adsMul - 1) * this.ads;
    void first;
    // aim recoil: learnable per-weapon spray pattern (see Recoil.ts)
    const ak = aimKick(d, this.shotsInSpray);
    this.pendingRecoil.x += (ak.v * adsMul * stanceMul * Math.PI) / 180;
    this.pendingRecoil.y += (ak.h * adsMul * stanceMul * Math.PI) / 180;
    // view kick (camera punch, does not move the aim) and weapon kick
    const vk = viewKick(d, this.ads);
    if (this.bipod > 0) {
      const k = 1 - 0.5 * this.bipod;
      vk.pitch *= k; vk.yaw *= k; vk.roll *= k; vk.back *= k;
    }
    this.rig.shotKick(vk);
    this.vm.kick(d, this.ads);
    this.flash.fire(d.sound.suppressed ? 0.25 : d.cls === 'Shotgun' ? 1.5 : d.cls === 'Sniper' ? 1.7 : d.cls === 'Marksman' ? 1.35 : d.cls === 'Pistol' ? 0.7 : 1);
    if (s.mag === 0 && (d.cls === 'Pistol' || d.cls === 'Assault Rifle' || d.cls === 'SMG' || d.cls === 'Marksman')) this.vm.boltLocked = true;

    // side-by-side: right barrel first, then left (flash + smoke come out of the one that fired)
    if (d.action === 'break') s.model.sockets.muzzle.position.x = s.mag >= 1 ? DB_W : -DB_W;
    // muzzle/eject screen positions for world-space FX
    this.vm.root.updateMatrixWorld(true);
    const mz = this.vm.socketCameraSpace('muzzle').project(this.vmCamera);
    const ej = this.vm.socketCameraSpace('eject').project(this.vmCamera);
    const origin = cam.getWorldPosition(new THREE.Vector3());
    this.hooks.onShot({ def: d, origin, dirs, muzzleScreen: mz, ejectScreen: ej, tracer: this.burstCount % d.tracerEvery === 1 || d.tracerEvery === 1 });
    if (d.modes[0] === 'pump' || d.modes[0] === 'bolt') {
      if (s.mag > 0 || d.modes[0] === 'bolt') this.cycleTimer = d.modes[0] === 'bolt' ? 0.26 : 0.14;
    }
  }
}
