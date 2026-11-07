import * as THREE from 'three';
import { Physics } from '../core/Physics';
import { Input } from '../core/Input';
import { CharacterBody, EYE_HEIGHT, RADIUS, Stance } from './CharacterBody';
import { clamp, damp, lerp, smoothstep, easeInOutCubic, easeOutCubic } from '../core/math';
import { Settings } from '../game/Settings';
import { LADDERS, LadderDef } from '../world/MapLayout';

export type MoveMode = 'idle' | 'walk' | 'sprint' | 'tactical' | 'slide' | 'air' | 'mantle';

export interface MoveEvents {
  onJump(): void;
  onLand(impactSpeed: number): void;
  onSlideStart(): void;
  onSlideEnd(): void;
  onMantle(height: number, vault: boolean): void;
  onFootstep(speed01: number, foot: 0 | 1): void;
  onStance(s: Stance): void;
  onTacSprint(): void;
  onDive?(): void;
  onDiveLand?(impactSpeed: number): void;
}

/** Tuning (metres, seconds). Exported so the in-game tuning panel can edit it live. */
export const T = {
  walk: 4.7,
  crouch: 2.7,
  prone: 1.0,
  sprint: 7.0,
  tactical: 8.6,
  adsMul: 0.6,
  accel: 11,
  decel: 13,
  sprintAccel: 6.5,
  airAccel: 1.6,
  gravity: 21,
  jumpVel: 6.6,
  slideBoost: 2.6,
  slideMin: 9.4,
  slideMax: 11.8,
  slideFriction: 6.2,
  slideMaxTime: 1.05,
  slideEndSpeed: 3.6,
  tacFuel: 3.2,
  tacRecharge: 2.2,
  coyote: 0.12,
  jumpBuffer: 0.14,
};
export const T_DEFAULTS = { ...T };
try {
  const saved = JSON.parse(localStorage.getItem('fjordfront.tuning') || '{}');
  for (const k of Object.keys(saved)) if (k in T && typeof saved[k] === 'number') (T as any)[k] = saved[k];
} catch {
  /* ignore */
}

export class PlayerController {
  body: CharacterBody;
  vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  mode: MoveMode = 'idle';
  eyeHeight = EYE_HEIGHT.stand;
  sprinting = false;
  tactical = false;
  tacFuel = T.tacFuel;
  private tacCooldown = 0;
  sliding = false;
  slideTime = 0;
  slideDir = new THREE.Vector3();
  private slideCooldown = 0;
  private slideBuffer = 0;
  private sinceGrounded = 0;
  private jumpBuffered = 0;
  private wantStance: 'stand' | 'crouch' | 'prone' = 'stand';
  private crouchHoldTime = 0;
  airTime = 0;
  /** Distance accumulator for footstep cadence */
  stepPhase = 0;
  lastFoot: 0 | 1 = 0;
  mantle: null | { p0: THREE.Vector3; p1: THREE.Vector3; p2: THREE.Vector3; t: number; dur: number; vault: boolean; exitVel: THREE.Vector3; h: number; /** swing onto this ladder at the end (climbing down from the top) */ ladder?: LadderDef } = null;
  /** External modifiers set by weapon system */
  ads = 0; // 0..1
  adsSpeedMul = T.adsMul;
  weaponSpeedMul = 1;
  /** stim (faster) / stun (slower) */
  statusSpeedMul = 1;
  /** dolphin dive: airborne lunge from a sprint that lands you prone */
  diving = false;
  private diveLandT = 0;
  blockSprint = false;
  onWaterTime = 0;
  frozen = false;
  dead = false;
  /** Smoothed values for camera/viewmodel */
  speed01 = 0;
  lookDX = 0;
  lookDY = 0;

  constructor(private physics: Physics, private input: Input, public ev: MoveEvents, start: THREE.Vector3) {
    this.body = new CharacterBody(physics, start);
  }

  get pos() {
    return this.body.pos;
  }
  get stance() {
    return this.body.stance;
  }
  get grounded() {
    return this.body.grounded;
  }

  forward(out = new THREE.Vector3()) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  eyePosition(out = new THREE.Vector3()) {
    return out.copy(this.body.pos).setY(this.body.pos.y + this.eyeHeight);
  }

  lookDirection(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  teleport(p: THREE.Vector3, yaw: number) {
    this.body.setStance('stand', true);
    this.body.teleport(p);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.mantle = null;
    this.ladder = null;
    this.sliding = false;
    this.sprinting = this.tactical = false;
    this.wantStance = 'stand';
    this.eyeHeight = EYE_HEIGHT.stand;
    this.tacFuel = T.tacFuel;
  }

  look(dx: number, dy: number, sensMul: number) {
    const s = 0.0022 * Settings.data.sensitivity * sensMul;
    this.yaw -= dx * s;
    this.pitch -= dy * s * (Settings.data.invertY ? -1 : 1);
    this.pitch = clamp(this.pitch, -1.53, 1.53);
    this.lookDX = dx * s;
    this.lookDY = dy * s;
  }

  addRecoil(pitch: number, yaw: number) {
    this.pitch = clamp(this.pitch + pitch, -1.53, 1.53);
    this.yaw += yaw;
  }

  /** set by the game while riding a zipline: where the feet must be this frame (physics bypassed) */
  zipFeet: THREE.Vector3 | null = null;

  update(dt: number) {
    const inp = this.input;
    if (this.zipFeet && !this.dead) {
      this.body.teleport(this.zipFeet);
      this.body.grounded = false;
      this.sprinting = this.tactical = false;
      if (this.sliding) this.endSlide(false);
      if (this.body.stance !== 'stand' && this.body.fits('stand', this.zipFeet)) this.body.setStance('stand');
      this.mode = 'air';
      this.airTime = 0;
      this.eyeHeight = damp(this.eyeHeight, EYE_HEIGHT.stand, 10, dt);
      return;
    }
    if (this.frozen || this.dead) {
      this.vel.x = damp(this.vel.x, 0, 8, dt);
      this.vel.z = damp(this.vel.z, 0, 8, dt);
      this.vel.y -= T.gravity * dt;
      const m = this.body.move(this.vel.clone().multiplyScalar(dt));
      if (this.body.grounded) this.vel.y = Math.max(this.vel.y, -1);
      return;
    }
    if (this.mantle) {
      this.updateMantle(dt);
      return;
    }
    if (this.updateLadder(dt)) return;

    const body = this.body;
    const wasGrounded = body.grounded;
    this.slideCooldown = Math.max(0, this.slideCooldown - dt);

    // ---- input ----
    const ix = inp.axis('left', 'right');
    const iz = inp.axis('back', 'forward');
    const fwd = this.forward();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const wish = new THREE.Vector3().addScaledVector(fwd, iz).addScaledVector(right, ix);
    if (wish.lengthSq() > 1) wish.normalize();
    const forwardHeld = iz > 0.5 && Math.abs(ix) < 0.9;

    if (inp.wasPressed('jump')) this.jumpBuffered = T.jumpBuffer;
    else this.jumpBuffered = Math.max(0, this.jumpBuffered - dt);

    // ---- stance input ----
    if (inp.wasPressed('crouch')) {
      this.crouchHoldTime = 0;
      if (this.sprinting && body.grounded && !this.sliding && this.slideCooldown <= 0 && this.horizSpeed() > 5.2) {
        this.startSlide();
      } else if (this.sprinting && !this.sliding && (!body.grounded || this.slideCooldown > 0 || this.horizSpeed() > 3.5)) {
        // pressed a touch early (still accelerating, mid-air, just out of a slide): buffer it
        this.slideBuffer = 0.2;
      } else if (this.sliding) {
        // slide cancel → stand up keeping a bit of momentum
        this.endSlide(true);
      } else if (Settings.data.toggleCrouch) {
        this.wantStance = this.wantStance === 'crouch' ? 'stand' : 'crouch';
      } else this.wantStance = 'crouch';
    }
    if (this.slideBuffer > 0) {
      this.slideBuffer -= dt;
      if (this.sprinting && body.grounded && !this.sliding && this.slideCooldown <= 0 && this.horizSpeed() > 5.2) {
        this.slideBuffer = 0;
        this.startSlide();
      }
    }
    if (inp.isDown('crouch')) {
      this.crouchHoldTime += dt;
      if (this.crouchHoldTime > 0.45 && !this.sliding && this.wantStance === 'crouch' && body.grounded && this.horizSpeed() < 3) {
        this.wantStance = 'prone';
        this.crouchHoldTime = -1e9;
      }
    }
    if (inp.wasReleased('crouch') && !Settings.data.toggleCrouch && this.wantStance === 'crouch') this.wantStance = 'stand';
    if (inp.wasPressed('prone') && this.sprinting && body.grounded && !this.sliding && !this.diving && this.horizSpeed() > 4.5) this.startDive(fwd);
    else if (inp.wasPressed('prone')) this.wantStance = this.wantStance === 'prone' ? 'crouch' : 'prone';

    // ---- sprint / tactical sprint ----
    this.tacCooldown = Math.max(0, this.tacCooldown - dt);
    const canSprint = forwardHeld && !this.sliding && this.ads < 0.5 && !this.blockSprint && body.stance !== 'prone';
    if (inp.wasPressed('sprint') && canSprint) {
      if (this.sprinting && !this.tactical && this.tacFuel > 0.6 && this.tacCooldown <= 0) {
        this.tactical = true;
        this.ev.onTacSprint();
      } else if (!this.sprinting) {
        this.sprinting = true;
        if (inp.sprintDoubleTap && this.tacFuel > 0.6) {
          this.tactical = true;
          this.ev.onTacSprint();
        }
      }
      if (this.wantStance !== 'stand') this.wantStance = 'stand';
    }
    if (!canSprint || iz <= 0) {
      if (!this.sliding) {
        this.sprinting = false;
        this.tactical = false;
      }
    }
    // tactical sprint is unlimited: it lasts as long as you keep sprinting forward
    this.tacFuel = T.tacFuel;
    this.tacCooldown = 0;

    // ---- apply stance ----
    if (!this.sliding) {
      const target: Stance = this.sprinting ? 'stand' : this.wantStance;
      if (target !== body.stance) {
        if (body.setStance(target)) this.ev.onStance(target);
        else if (target === 'stand' && body.stance === 'prone' && body.setStance('crouch')) this.ev.onStance('crouch');
      }
      if (body.stance !== 'stand') {
        this.sprinting = false;
        this.tactical = false;
      }
      // keep wantStance in sync when blocked
      if (body.stance === 'crouch' && this.wantStance === 'stand' && !body.fits('stand')) {
        /* stay crouched under low ceilings */
      }
    }

    // ---- horizontal movement ----
    const onGround = body.grounded;
    if (onGround) this.sinceGrounded = 0;
    else this.sinceGrounded += dt;

    if (this.sliding) {
      this.updateSlide(dt, wish);
    } else if (this.diving || this.diveLandT > 0) {
      // committed: no steering in the air; after touchdown the body skids to a stop on its belly
      if (this.diveLandT > 0 && onGround) {
        this.diveLandT -= dt;
        this.vel.x = damp(this.vel.x, 0, 3.6, dt);
        this.vel.z = damp(this.vel.z, 0, 3.6, dt);
      }
    } else {
      let max = T.walk;
      if (body.stance === 'crouch') max = T.crouch;
      if (body.stance === 'prone') max = T.prone;
      if (this.sprinting) max = this.tactical ? T.tactical : T.sprint;
      max *= lerp(1, this.adsSpeedMul, this.ads);
      max *= this.weaponSpeedMul * this.statusSpeedMul;
      const target = wish.clone().multiplyScalar(max);
      const hv = new THREE.Vector3(this.vel.x, 0, this.vel.z);
      if (onGround) {
        const accelerating = target.lengthSq() > hv.lengthSq() * 0.98;
        const k = accelerating ? (this.sprinting ? T.sprintAccel : T.accel) : T.decel;
        // direction changes are snappier than raw acceleration
        hv.x = damp(hv.x, target.x, k, dt);
        hv.z = damp(hv.z, target.z, k, dt);
      } else {
        // air control: steer, never add beyond current/target speed
        const cur = hv.length();
        hv.x = damp(hv.x, target.x, T.airAccel, dt);
        hv.z = damp(hv.z, target.z, T.airAccel, dt);
        const cap = Math.max(cur, max * 0.75);
        if (hv.length() > cap) hv.setLength(cap);
      }
      this.vel.x = hv.x;
      this.vel.z = hv.z;
    }

    // ---- jump / mantle ----
    const canCoyote = this.sinceGrounded < T.coyote && this.vel.y <= 0.5;
    if (this.jumpBuffered > 0) {
      if (this.tryMantle(true)) {
        this.jumpBuffered = 0;
        return;
      }
      if (body.grounded || canCoyote) {
        if (body.stance === 'prone') {
          if (body.setStance('crouch')) this.ev.onStance('crouch');
          this.wantStance = 'crouch';
        } else if (body.stance === 'crouch' && !this.sliding) {
          if (body.setStance('stand')) {
            this.wantStance = 'stand';
            this.ev.onStance('stand');
          }
        } else {
          if (this.sliding) this.endSlide(false, true);
          this.vel.y = T.jumpVel;
          this.sinceGrounded = 1;
          this.ev.onJump();
          this.tactical = this.tactical && this.tacFuel > 0;
        }
        this.jumpBuffered = 0;
      }
    }
    // auto-mantle when airborne and pushing into a ledge
    if (!body.grounded && forwardHeld && inp.isDown('jump') && this.vel.y < 2.5) {
      if (this.tryMantle(false)) return;
    }

    // ---- gravity & integrate ----
    if (!body.grounded || this.vel.y > 0) this.vel.y -= T.gravity * dt;
    this.vel.y = Math.max(this.vel.y, -55);
    const prevVy = this.vel.y;
    const delta = this.vel.clone().multiplyScalar(dt);
    const snap = this.vel.y <= 0.1 && wasGrounded;
    const moved = body.move(delta, snap);
    if (dt > 0) {
      // lose momentum into walls, keep tangential motion
      const mvx = moved.x / dt, mvz = moved.z / dt;
      if (Math.abs(mvx) < Math.abs(this.vel.x)) this.vel.x = mvx;
      if (Math.abs(mvz) < Math.abs(this.vel.z)) this.vel.z = mvz;
      if (this.vel.y > 0 && moved.y < delta.y * 0.5) this.vel.y = 0; // head bonk
    }
    if (body.grounded) {
      if (this.diving && this.airTime > 0.05) {
        this.diving = false;
        this.diveLandT = 0.55;
        body.setStance('prone', true);
        this.wantStance = 'prone';
        this.ev.onDiveLand?.(-prevVy);
      } else if (!wasGrounded && this.airTime > 0.08) {
        this.ev.onLand(-prevVy);
        if (this.sliding === false && this.sprinting && inp.isDown('crouch')) this.startSlide();
      }
      if (this.vel.y < 0) this.vel.y = -1.5;
      this.airTime = 0;
    } else {
      this.airTime += dt;
    }

    // ---- derived ----
    const hs = this.horizSpeed();
    this.speed01 = damp(this.speed01, clamp(hs / T.sprint, 0, 1.3), 10, dt);
    this.mode = !body.grounded ? 'air' : this.sliding ? 'slide' : hs < 0.3 ? 'idle' : this.tactical ? 'tactical' : this.sprinting ? 'sprint' : 'walk';

    // footsteps (distance based)
    if (body.grounded && !this.sliding && hs > 0.6) {
      const stride = this.sprinting ? (this.tactical ? 2.0 : 1.75) : body.stance === 'crouch' ? 0.95 : body.stance === 'prone' ? 0.8 : 1.35;
      this.stepPhase += (hs * dt) / stride;
      if (this.stepPhase >= 1) {
        this.stepPhase -= 1;
        this.lastFoot = this.lastFoot === 0 ? 1 : 0;
        this.ev.onFootstep(clamp(hs / T.tactical, 0, 1) * (body.stance === 'stand' ? 1 : 0.45), this.lastFoot);
      }
    }

    // eye height
    const eyeT = this.sliding ? EYE_HEIGHT.slide : EYE_HEIGHT[body.stance];
    this.eyeHeight = damp(this.eyeHeight, eyeT, this.sliding ? 14 : 11, dt);
  }

  ladder: LadderDef | null = null;
  private ladderStep = 0;
  private ladderLatch = false;
  /** Ladder climbing: walk into a ladder to grab it, W/S to climb, jump to let go; tops out automatically. */
  private updateLadder(dt: number): boolean {
    const inp = this.input;
    const p = this.body.pos;
    const fwd = this.forward();
    if (!this.ladder) {
      if (!inp.isDown('forward')) return false;
      for (const l of LADDERS) {
        const fx = l.x + l.nx * 0.45, fz = l.z + l.nz * 0.45;
        // from the top: walk over the edge towards the ladder side and swing onto it
        if (p.y > l.y1 - 0.4 && p.y < l.y1 + 1.2 && Math.hypot(p.x - l.x, p.z - l.z) < 1.15 && fwd.x * l.nx + fwd.z * l.nz > 0.45 && (p.x - l.x) * l.nx + (p.z - l.z) * l.nz < 0.2) {
          this.sprinting = this.tactical = this.sliding = false;
          this.body.setStance('stand', true);
          this.ladderLatch = true;
          this.mantle = { p0: p.clone(), p1: new THREE.Vector3(fx, p.y + 0.15, fz), p2: new THREE.Vector3(fx, Math.max(l.y0 + 0.05, l.y1 - 2.15), fz), t: 0, dur: 0.7, vault: false, exitVel: new THREE.Vector3(), h: 1.2, ladder: l };
          this.body.setEnabled(false);
          this.ev.onMantle(1.0, false);
          return true;
        }
        if (Math.hypot(p.x - fx, p.z - fz) > 0.6 || p.y < l.y0 - 0.4 || p.y > l.y1) continue;
        if (fwd.x * -l.nx + fwd.z * -l.nz < 0.35) continue;
        this.ladder = l;
        this.ladderLatch = false;
        this.sprinting = this.tactical = this.sliding = false;
        this.body.setStance('stand', true);
        break;
      }
      if (!this.ladder) return false;
    }
    const l = this.ladder;
    // after swinging on from the top, W keeps going down until it is released
    if (this.ladderLatch && !inp.isDown('forward')) this.ladderLatch = false;
    const iz = this.ladderLatch ? -1 : inp.axis('back', 'forward');
    const spd = l.speed ?? 3.4;
    if (inp.wasPressed('jump')) {
      this.ladder = null;
      this.vel.set(l.nx * 3, 2.5, l.nz * 3);
      return false;
    }
    // hug the ladder, move vertically
    const target = new THREE.Vector3(l.x + l.nx * 0.45, p.y, l.z + l.nz * 0.45);
    const delta = new THREE.Vector3((target.x - p.x) * Math.min(1, dt * 10), iz * spd * dt, (target.z - p.z) * Math.min(1, dt * 10));
    this.body.move(delta, false);
    this.vel.set(0, iz * spd, 0);
    this.ladderStep += Math.abs(iz) * spd * dt;
    if (this.ladderStep > 0.6) {
      this.ladderStep = 0;
      this.ev.onFootstep(0.4, this.lastFoot = this.lastFoot === 0 ? 1 : 0);
    }
    this.eyeHeight = damp(this.eyeHeight, EYE_HEIGHT.stand, 10, dt);
    this.speed01 = damp(this.speed01, 0.2, 8, dt);
    this.mode = 'idle';
    if (p.y >= l.y1 - 0.9 && iz > 0) {
      // climb over the top onto the roof
      this.ladder = null;
      const e = new THREE.Vector3(...l.exit);
      this.mantle = { p0: p.clone(), p1: new THREE.Vector3(p.x, e.y, p.z), p2: e, t: 0, dur: 0.55, vault: false, exitVel: new THREE.Vector3(), h: 1.4 };
      this.body.setEnabled(false);
      this.ev.onMantle(1.4, false);
      return true;
    }
    if (p.y <= l.y0 + 0.05 && iz < 0) this.ladder = null;
    if (this.body.grounded && iz < 0 && p.y < l.y0 + 0.3) this.ladder = null;
    return true;
  }

  horizSpeed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  // ---------------- slide ----------------
  private startDive(fwd: THREE.Vector3) {
    const hv = new THREE.Vector3(this.vel.x, 0, this.vel.z);
    const dir = hv.lengthSq() > 1 ? hv.normalize() : fwd.clone();
    const sp = Math.max(this.horizSpeed(), T.sprint) * 1.12;
    this.vel.set(dir.x * sp, 4.3, dir.z * sp);
    this.diving = true;
    this.sprinting = false;
    this.tactical = false;
    this.body.setStance('crouch', true);
    this.wantStance = 'prone';
    this.sinceGrounded = 1;
    this.ev.onDive?.();
  }

  private startSlide() {
    if (!this.body.setStance('slide')) return;
    const hv = new THREE.Vector3(this.vel.x, 0, this.vel.z);
    const sp = clamp(Math.max(hv.length() + T.slideBoost, T.slideMin), 0, T.slideMax);
    this.slideDir.copy(hv.lengthSq() > 0.01 ? hv.normalize() : this.forward());
    this.vel.x = this.slideDir.x * sp;
    this.vel.z = this.slideDir.z * sp;
    this.sliding = true;
    this.slideTime = 0;
    this.tactical = false;
    this.ev.onSlideStart();
  }

  private updateSlide(dt: number, wish: THREE.Vector3) {
    this.slideTime += dt;
    const hv = new THREE.Vector3(this.vel.x, 0, this.vel.z);
    let sp = hv.length();
    // slope acceleration
    const n = this.body.groundNormal;
    const downhill = new THREE.Vector3(n.x, 0, n.z);
    const slopeAcc = downhill.dot(this.slideDir) * T.gravity * 0.9;
    // burst → glide → bleed: almost no friction for the first moments, then it ramps in
    const fric = T.slideFriction * smoothstep(0.12, 0.45, this.slideTime) * (this.body.grounded ? 1 : 0.15);
    sp = Math.max(0, sp + (slopeAcc - fric) * dt);
    sp = Math.min(sp, 14);
    // slight steering
    const fwd = this.forward();
    // MW-style: the slide keeps its line while you look around freely; strafing input steers a little
    void fwd;
    if (wish.lengthSq() > 0.1) this.slideDir.lerp(wish.clone().normalize(), 1 - Math.exp(-0.9 * dt)).normalize();
    this.vel.x = this.slideDir.x * sp;
    this.vel.z = this.slideDir.z * sp;
    if (sp < T.slideEndSpeed || this.slideTime > T.slideMaxTime * (slopeAcc > 2 ? 2.5 : 1)) this.endSlide(false);
  }

  private endSlide(cancelToStand: boolean, jumping = false) {
    this.sliding = false;
    // a crisp, early slide-cancel is rewarded: you pop up still carrying sprint speed
    if (cancelToStand && this.slideTime < 0.45) {
      const hv = new THREE.Vector3(this.vel.x, 0, this.vel.z);
      const sp = Math.min(hv.length(), T.sprint * 1.12);
      if (hv.lengthSq() > 0.01) {
        hv.normalize().multiplyScalar(sp);
        this.vel.x = hv.x;
        this.vel.z = hv.z;
      }
    }
    this.slideCooldown = 0.25;
    this.ev.onSlideEnd();
    if (jumping || cancelToStand) {
      if (this.body.setStance('stand')) {
        this.wantStance = 'stand';
        this.sprinting = cancelToStand || this.sprinting;
      } else {
        this.body.setStance('crouch', true);
        this.wantStance = 'crouch';
      }
    } else {
      this.body.setStance('crouch', true);
      this.wantStance = 'crouch';
      this.sprinting = false;
    }
    this.ev.onStance(this.body.stance);
  }

  // ---------------- mantle / vault ----------------
  /** set by the game: a window in front to dive through (it breaks it), or null */
  windowVault: ((feet: THREE.Vector3, fwd: THREE.Vector3) => { over: THREE.Vector3; land: THREE.Vector3; sill: number } | null) | null = null;

  private tryMantle(fromJump: boolean): boolean {
    const body = this.body;
    if (body.stance === 'prone') return false;
    const fwd = this.forward();
    const feet = body.pos;
    // windows (from inside or out): vault straight through, taking the glass and frame with you
    if (fromJump && this.windowVault) {
      const wv = this.windowVault(feet.clone(), fwd);
      if (wv) {
        const hs = Math.max(this.horizSpeed(), 3.5);
        const h = wv.sill - feet.y;
        body.setEnabled(false);
        body.setStance('prone', true);
        this.mantle = { p0: feet.clone(), p1: wv.over, p2: wv.land, t: 0, dur: 0.48 + Math.max(0, h) * 0.1, vault: true, exitVel: fwd.clone().multiplyScalar(Math.min(hs, 5.5)), h: Math.max(0.5, h) };
        this.sliding = false;
        this.tactical = false;
        this.ev.onMantle(Math.max(0.5, h), true);
        return true;
      }
    }
    const reach = RADIUS + (fromJump ? 0.75 : 0.55);
    let wallDist = Infinity;
    let wallPoint: THREE.Vector3 | null = null;
    for (const hgt of [0.5, 0.95, 1.4]) {
      const o = new THREE.Vector3(feet.x, feet.y + hgt, feet.z);
      const h = this.physics.raycast(o, fwd, reach);
      if (h && Math.abs(h.normal.y) < 0.6 && h.distance < wallDist) {
        wallDist = h.distance;
        wallPoint = h.point;
      }
    }
    if (!wallPoint) return false;
    // find the top of the obstacle
    let ledgeY = -Infinity;
    let topPoint: THREE.Vector3 | null = null;
    const maxClimb = 2.25;
    for (const depth of [0.2, 0.4]) {
      const probe = new THREE.Vector3(wallPoint.x + fwd.x * depth, feet.y + maxClimb + 0.35, wallPoint.z + fwd.z * depth);
      const h = this.physics.raycast(probe, new THREE.Vector3(0, -1, 0), maxClimb + 0.35);
      if (h && h.normal.y > 0.65 && h.distance > 0.05) {
        if (h.point.y > ledgeY) {
          ledgeY = h.point.y;
          topPoint = h.point;
        }
      }
    }
    if (!topPoint) return false;
    const height = ledgeY - feet.y;
    if (height < 0.45 || height > maxClimb) return false;
    // something above the ledge between us and it? (low ceiling)
    const up = this.physics.raycast(new THREE.Vector3(feet.x, feet.y + 1.0, feet.z), new THREE.Vector3(0, 1, 0), height + 0.6);
    if (up) return false;

    // vault check: is the obstacle thin with lower ground behind it?
    let vault = false;
    let landing: THREE.Vector3 | null = null;
    if (height < 1.35) {
      const beyond = new THREE.Vector3(wallPoint.x + fwd.x * 1.05, ledgeY + 0.3, wallPoint.z + fwd.z * 1.05);
      const blocked = this.physics.raycast(new THREE.Vector3(topPoint.x, ledgeY + 0.3, topPoint.z), fwd, 0.85);
      if (!blocked) {
        const g = this.physics.raycast(beyond, new THREE.Vector3(0, -1, 0), 4);
        if (g && g.point.y < ledgeY - 0.45) {
          vault = true;
          landing = new THREE.Vector3(beyond.x + fwd.x * 0.35, g.point.y, beyond.z + fwd.z * 0.35);
        }
      }
    }
    const crouchFits = (p: THREE.Vector3, s: Stance) => body.fits(s, p);
    const topStand = new THREE.Vector3(topPoint.x + fwd.x * (RADIUS + 0.05), ledgeY + 0.02, topPoint.z + fwd.z * (RADIUS + 0.05));
    if (vault && landing) {
      // need crouch clearance on top of the obstacle (windows)
      const over = new THREE.Vector3(topPoint.x, ledgeY + 0.05, topPoint.z);
      if (!crouchFits(over, 'slide') && !crouchFits(over, 'prone')) vault = false;
      if (vault && !crouchFits(landing, 'crouch')) vault = false;
    }
    if (!vault) {
      if (!crouchFits(topStand, 'crouch')) return false;
    }
    const hs = Math.max(this.horizSpeed(), 3.5);
    const p0 = feet.clone();
    let p1: THREE.Vector3, p2: THREE.Vector3, dur: number;
    if (vault && landing) {
      p1 = new THREE.Vector3(topPoint.x, ledgeY + 0.12, topPoint.z);
      p2 = landing;
      dur = 0.42 + height * 0.08;
    } else {
      p1 = new THREE.Vector3(feet.x + fwd.x * Math.max(0, wallDist - RADIUS - 0.05), ledgeY + 0.08, feet.z + fwd.z * Math.max(0, wallDist - RADIUS - 0.05));
      p2 = topStand;
      dur = 0.26 + height * 0.2;
    }
    body.setEnabled(false);
    body.setStance('prone', true);
    this.mantle = {
      p0, p1, p2, t: 0, dur, vault,
      // sprinting into a climb carries you over the top; a standing climb steps off slowly
      exitVel: fwd.clone().multiplyScalar(vault ? Math.min(hs, 7) : this.sprinting ? Math.min(hs * 0.65, 4.2) : Math.min(hs * 0.4, 2.5)),
      h: height,
    };
    this.sliding = false;
    this.tactical = false;
    this.ev.onMantle(height, vault);
    return true;
  }

  private updateMantle(dt: number) {
    const m = this.mantle!;
    m.t += dt / m.dur;
    const t = clamp(m.t, 0, 1);
    const p = new THREE.Vector3();
    if (m.vault) {
      // arc over the obstacle
      const a = easeInOutCubic(t);
      const q0 = m.p0.clone().lerp(m.p1, smoothstep(0, 0.5, a));
      const q1 = m.p1.clone().lerp(m.p2, smoothstep(0.5, 1, a));
      p.copy(a < 0.5 ? q0 : q1);
      p.y += Math.sin(t * Math.PI) * 0.25;
      this.eyeHeight = damp(this.eyeHeight, EYE_HEIGHT.crouch + 0.15, 12, dt);
    } else {
      // rise, then step forward
      const rise = easeOutCubic(clamp(t / 0.62, 0, 1));
      const fwd = easeInOutCubic(clamp((t - 0.35) / 0.65, 0, 1));
      p.set(lerp(m.p0.x, m.p1.x, rise), lerp(m.p0.y, m.p1.y, rise), lerp(m.p0.z, m.p1.z, rise));
      p.x = lerp(p.x, m.p2.x, fwd);
      p.z = lerp(p.z, m.p2.z, fwd);
      p.y = lerp(p.y, m.p2.y, fwd);
      this.eyeHeight = damp(this.eyeHeight, EYE_HEIGHT.crouch, 10, dt);
    }
    this.body.teleport(p);
    if (m.t >= 1 && m.ladder) {
      this.body.setEnabled(true);
      this.body.teleport(m.p2);
      this.vel.set(0, 0, 0);
      this.ladder = m.ladder;
      this.mantle = null;
      this.mode = 'idle';
      return;
    }
    if (m.t >= 1) {
      this.body.setEnabled(true);
      this.body.teleport(m.p2);
      if (this.body.fits('stand')) this.body.setStance('stand');
      else this.body.setStance('crouch', true);
      this.wantStance = this.body.stance === 'stand' ? 'stand' : 'crouch';
      this.vel.copy(m.exitVel);
      this.vel.y = 0;
      this.mantle = null;
      this.mode = 'walk';
      // continue sprinting if still holding forward after a vault
      this.sprinting = m.vault && this.input.isDown('forward') && this.sprinting;
    }
  }
}
