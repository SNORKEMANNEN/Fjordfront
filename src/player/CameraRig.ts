import * as THREE from 'three';
import { PlayerController } from './PlayerController';
import { Spring, Spring3, damp, clamp, simplex2 } from '../core/math';
import { Settings } from '../game/Settings';

/** Converts player state into a cinematic first-person camera: bob, tilt, FOV, impacts, shake. */
export class CameraRig {
  land = new Spring(170, 15);
  landPitch = new Spring(140, 13);
  kick = new Spring3(260, 22); // visual-only recoil kick (pitch, yaw, roll)
  roll = 0;
  /** sideways head offset (m, + right) for door peeking, set by the game */
  peekLean = 0;
  private lastEyeY: number | null = null;
  private stepOff = 0;
  fovMul = 1;
  trauma = 0;
  private t = 0;
  bobOffset = new THREE.Vector3();
  private tmpBack = new THREE.Vector3();
  bobRot = new THREE.Euler();
  /** extra rotation from mantle/slide events */
  private mantleDip = new Spring(90, 11);

  constructor(public camera: THREE.PerspectiveCamera) {}

  onLand(speed: number) {
    const s = clamp(speed / 12, 0, 1.4);
    this.land.impulse(-s * 2.4);
    this.landPitch.impulse(-s * 1.3);
  }
  onJump() {
    this.landPitch.impulse(0.25);
    this.land.impulse(0.3);
  }
  /** slide entry: the body drops and pitches into the slide, lean settles in with a little overshoot */
  onSlideStart() {
    this.land.impulse(-1.1);
    this.mantleDip.impulse(-0.9);
    this.slideLean.impulse(0.9);
  }
  /** slide exit / cancel: a quick lift as the legs come back under you */
  onSlideEnd() {
    this.land.impulse(0.7);
    this.landPitch.impulse(0.35);
  }
  private slideLean = new Spring(120, 10);
  /** per-shot view kick: snappy, slightly under-damped rotation + a small shove and FOV punch */
  private shotRot = new Spring3(620, 30);
  private shotBack = new Spring(560, 36);
  private shotFov = new Spring(480, 30);
  shotKick(k: { pitch: number; yaw: number; roll: number; back: number; fov: number }) {
    const w = Math.sqrt(620) * 1.65; // impulse that peaks at roughly the requested displacement
    this.shotRot.impulse(k.pitch * w, k.yaw * w, k.roll * w);
    this.shotBack.impulse(k.back * Math.sqrt(560) * 1.6);
    this.shotFov.impulse(-k.fov * Math.sqrt(480) * 1.6);
  }
  private killPunchS = new Spring(210, 14);
  /** elimination: a tiny FOV punch-in and settle (felt more than seen) */
  killPunch(strength = 1) {
    this.killPunchS.impulse(-1.2 * strength);
    this.kick.impulse(-0.006 * strength, 0, (Math.random() - 0.5) * 0.012 * strength);
  }
  onMantle(h: number) {
    this.mantleDip.impulse(-0.8 - h * 0.4);
  }
  onRecoil(pitch: number, yaw: number, roll: number) {
    this.kick.impulse(pitch, yaw, roll);
  }
  addTrauma(a: number) {
    this.trauma = clamp(this.trauma + a, 0, 1);
  }

  hFovToV(h: number, aspect: number) {
    return (2 * Math.atan(Math.tan((h * Math.PI) / 360) / aspect) * 180) / Math.PI;
  }

  update(dt: number, p: PlayerController, adsZoom: number, adsAmount: number, extraRoll = 0) {
    this.t += dt;
    const cam = this.camera;
    const sp = p.speed01;
    const grounded = p.grounded && !p.sliding;
    // ---- head bob synced to footsteps ----
    const s = p.stepPhase;
    const adsDamp = 1 - adsAmount * 0.85;
    const ampY = (p.tactical ? 0.05 : p.sprinting ? 0.038 : 0.02) * clamp(sp * 1.4, 0, 1) * adsDamp * (grounded ? 1 : 0);
    const ampX = ampY * 0.7;
    const by = ampY * (0.5 - 0.5 * Math.cos(s * Math.PI * 2)) - ampY * 0.5;
    const bx = ampX * Math.sin(s * Math.PI) * (p.lastFoot === 0 ? 1 : -1);
    this.bobOffset.x = damp(this.bobOffset.x, bx, 20, dt);
    this.bobOffset.y = damp(this.bobOffset.y, by, 20, dt);

    // ---- roll: strafe tilt + slide lean ----
    const right = new THREE.Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
    const lateral = p.vel.dot(right);
    let rollT = -lateral * 0.0045 * adsDamp;
    if (p.sliding) rollT += 0.095 * Math.min(1, p.slideTime / 0.12);
    if (p.mantle) rollT += p.mantle.vault ? -0.05 : 0.03;
    rollT += extraRoll;
    this.roll = damp(this.roll, rollT, p.sliding ? 9 : 8, dt);

    // ---- FOV ----
    let fm = 1;
    if (p.sprinting) fm = p.tactical ? 1.09 : 1.045;
    if (p.sliding) fm = 1.085;
    this.fovMul = damp(this.fovMul, fm, 6, dt);
    const hip = this.hFovToV(Settings.data.fov, cam.aspect);
    // ADS FOV 'independent': the aimed picture is always the default 80° base divided by the zoom,
    // whatever hip FOV is chosen; 'affected' scales the ADS picture with the hip FOV (default).
    const adsBase = Settings.data.adsFov === 'independent' ? this.hFovToV(80, cam.aspect) : hip;
    const base = hip + (adsBase - hip) * adsAmount;
    const zoom = 1 + (adsZoom - 1) * adsAmount;
    const fov = (base * this.fovMul * (1 + this.killPunchS.value * 0.012) * (1 + this.shotFov.value)) / zoom;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }

    // ---- springs ----
    this.land.update(dt);
    this.landPitch.update(dt);
    this.kick.update(dt);
    this.mantleDip.update(dt);
    this.slideLean.update(dt);
    this.killPunchS.update(dt);
    this.shotRot.update(dt);
    this.shotBack.update(dt);
    this.shotFov.update(dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.2);
    const tr = this.trauma * this.trauma;
    const shX = simplex2(this.t * 18, 1.3) * tr * 0.05;
    const shY = simplex2(this.t * 18, 7.9) * tr * 0.05;
    const shR = simplex2(this.t * 14, 3.1) * tr * 0.06;

    // ---- compose ----
    const eye = p.eyePosition();
    // stairs, kerbs and door sills: the controller steps the body up/down in a single frame; the
    // eye eases over the step instead of popping (only small grounded steps, never jumps/falls)
    if (this.lastEyeY !== null && p.grounded && !p.mantle && !p.ladder) {
      const dy = eye.y - this.lastEyeY;
      if (Math.abs(dy) > 0.035 && Math.abs(dy) < 0.6) this.stepOff -= dy;
    }
    this.lastEyeY = eye.y;
    this.stepOff *= Math.exp(-dt * 13);
    if (Math.abs(this.stepOff) > 0.45) this.stepOff = Math.sign(this.stepOff) * 0.45;
    eye.y += this.stepOff;
    eye.y += this.bobOffset.y + this.land.value * 0.06;
    const pitch = p.pitch + this.landPitch.value * 0.035 + this.kick.value.x + this.shotRot.value.x + shX + this.mantleDip.value * 0.05;
    const yaw = p.yaw + this.kick.value.y + this.shotRot.value.y + shY + this.bobOffset.x * 0.12;
    cam.position.copy(eye).addScaledVector(right, this.bobOffset.x + this.peekLean);
    // leaning swings the head out from the hips, so it also drops a little
    cam.position.y -= Math.abs(this.peekLean) * 0.12;
    // shove the eye back along the view direction a touch on each shot
    const back = this.shotBack.value;
    if (back !== 0) cam.position.add(this.tmpBack.set(Math.sin(p.yaw) * back, 0, Math.cos(p.yaw) * back));
    cam.rotation.set(0, 0, 0, 'YXZ');
    cam.rotation.y = yaw;
    cam.rotation.x = pitch;
    cam.rotation.z = this.roll + this.slideLean.value * 0.03 + this.kick.value.z + this.shotRot.value.z + shR + this.bobOffset.x * 0.25;
    cam.updateMatrixWorld();
  }
}
