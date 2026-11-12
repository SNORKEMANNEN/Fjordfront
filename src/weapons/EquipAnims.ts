import * as THREE from 'three';
import { POSES, FingerPose } from './Arms';
import { handFrame } from './ReloadClips';
import { clamp, smoothstep, easeInOutCubic } from '../core/math';
import { setLed } from './EquipmentModels';

/**
 * First-person equipment handling (Update 23).
 *
 * Tacticals (flash, stun, smoke, decoy, snapshot): the gun stays up in the right hand (you can keep
 * shooting); only the left hand works. It pulls the grenade off the vest, the left thumb hooks the
 * ring and the wrist twists it out (the snapshot instead gets a quarter-turn of its cap), then the
 * arm cocks back and holds there until the key is released, and throws.
 *
 * Lethals: the gun drops away first.
 *  frag    right hand pulls it, the LEFT fingers pull the pin, the right arm cocks back and holds
 *          (cooking) until release
 *  sticky  right hand pulls it, the left index presses the arming button, same ready & throw
 *  knife   right hand plucks it straight off the chest into the over-the-shoulder ready position
 *  C4      both hands bring the brick up, a two-handed toss on release, then the gun comes back
 *          up in the right hand while the left pulls the detonator and keeps it ready
 *
 * Every item is placed exactly by the animation (no palm snapping), and hands that touch an item
 * are solved from that item, so fingers, rings and buttons line up.
 */
export type Pose = { p: THREE.Vector3; q: THREE.Quaternion };
export interface EqCtx {
  freeL: { b: number; p: THREE.Vector3; q: THREE.Quaternion; pose: FingerPose };
  freeR: { b: number; p: THREE.Vector3; q: THREE.Quaternion };
  setRPose: (fp: FingerPose) => void;
  item: () => THREE.Group;
  hold: (name: string) => void;
  /** palm contact point for a wrist pose (side, wrist, q, extra distance off the palm) */
  palmAt: (side: 'L' | 'R', wrist: THREE.Vector3, q: THREE.Quaternion, off: number) => THREE.Vector3;
  wristAt: (side: 'L' | 'R', anchor: THREE.Vector3, q: THREE.Quaternion, r: number) => THREE.Vector3;
  noWrapL: () => void;
  ev: (name: string) => void;
  jolt: (u: number, r: number, b?: number) => void;
  time: number;
  data: Record<string, unknown>;
  /** 0..1 cook progress of a live frag in the hand (-1: not cooking) */
  cook: number;
  /** 0..1 throw power (grows with how long the throw key is held) */
  power: number;
  /** seconds the action has been holding at its ready point */
  held: number;
  /** the gun in the right hand (for the one-handed tactical throw) */
  cls: string;
  bipod: number;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
type K3 = [number, [number, number, number]][];
function kv(t: number, keys: K3, out = new THREE.Vector3()) {
  if (t <= keys[0][0]) return out.set(...keys[0][1]);
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, a] = keys[i - 1], [t1, b] = keys[i];
      const u = smoothstep(0, 1, (t - t0) / Math.max(1e-6, t1 - t0));
      return out.set(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
    }
  }
  return out.set(...keys[keys.length - 1][1]);
}
function kf(t: number, keys: [number, number][]) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, a] = keys[i - 1], [t1, b] = keys[i];
      return a + (b - a) * easeInOutCubic((t - t0) / Math.max(1e-6, t1 - t0));
    }
  }
  return keys[keys.length - 1][1];
}
/** hand orientation track from finger-direction and palm-normal keys */
function handTrack(t: number, f: K3, n: K3) {
  return handFrame(kv(t, f), kv(t, n));
}
function mixFP(a: FingerPose, b: FingerPose, u: number): FingerPose {
  const m3 = (x: [number, number, number], y: [number, number, number]) => x.map((v, i) => v + (y[i] - v) * u) as [number, number, number];
  return { index: m3(a.index, b.index), middle: m3(a.middle, b.middle), ring: m3(a.ring, b.ring), pinky: m3(a.pinky, b.pinky), thumb: a.thumb.map((v, i) => v + (b.thumb[i] - v) * u) as [number, number, number, number], spread: (a.spread ?? 0) + ((b.spread ?? 0) - (a.spread ?? 0)) * u };
}
const FP_RING: FingerPose = { index: [-0.55, -0.85, -0.6], middle: [-1.2, -1.3, -0.8], ring: [-1.3, -1.35, -0.85], pinky: [-1.35, -1.3, -0.8], thumb: [0.15, -0.6, -0.55, -0.35], spread: 0.02 };
const FP_POKE: FingerPose = { index: [-0.1, -0.15, -0.1], middle: [-1.2, -1.3, -0.8], ring: [-1.3, -1.35, -0.85], pinky: [-1.35, -1.3, -0.8], thumb: [0.35, -0.6, -0.5, -0.3] };
const FP_THUMBHOOK: FingerPose = { index: [-1.0, -1.1, -0.65], middle: [-1.1, -1.15, -0.65], ring: [-1.15, -1.15, -0.65], pinky: [-1.2, -1.15, -0.65], thumb: [0.1, -1.1, -1.0, -0.8] };
const FP_KNIFE: FingerPose = { index: [-0.35, -0.5, -0.35], middle: [-0.6, -0.8, -0.5], ring: [-1.25, -1.3, -0.8], pinky: [-1.3, -1.3, -0.8], thumb: [0.2, -0.45, -0.4, -0.25] };

/** where a held item sits for a wrist pose: centre off the palm by `off`, rotated by `e` (hand space) */
function itemFrom(c: EqCtx, side: 'L' | 'R', wrist: THREE.Vector3, q: THREE.Quaternion, off: number, e: [number, number, number], shift = V(0, 0, 0)): Pose {
  const p = c.palmAt(side, wrist, q, off).add(shift.clone().applyQuaternion(q));
  return { p, q: q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...e))) };
}
function place(o: THREE.Object3D, ps: Pose) {
  o.position.copy(ps.p);
  o.quaternion.copy(ps.q);
  o.userData.posed = true;
}
/** the ring's position in root space for an item pose */
function ringWorld(item: THREE.Object3D, ps: Pose) {
  const ring = item.getObjectByName('ring');
  const rest = (ring?.userData.rest as THREE.Vector3 | undefined) ?? ring?.position ?? V(0, 0.05, 0);
  return rest.clone().applyQuaternion(ps.q).add(ps.p);
}
function ringRest(item: THREE.Object3D) {
  const ring = item.getObjectByName('ring');
  if (ring && !ring.userData.rest) ring.userData.rest = ring.position.clone();
  return ring;
}
/** move the ring to a root-space point (it rides on the fingertip while being pulled) */
function ringTo(item: THREE.Object3D, ps: Pose, world: THREE.Vector3) {
  const ring = item.getObjectByName('ring');
  if (!ring) return;
  ring.position.copy(world.clone().sub(ps.p).applyQuaternion(ps.q.clone().invert()));
}
/** fingertip pinch point of a hand (a few cm past the palm along the fingers) */
function pinchPoint(c: EqCtx, side: 'L' | 'R', wrist: THREE.Vector3, q: THREE.Quaternion) {
  return c.palmAt(side, wrist, q, 0.0).add(V(0, -0.006, -0.042).applyQuaternion(q));
}
const once = (c: EqCtx, key: string, t: number, at: number, f: () => void) => {
  const fired = (c.data.fired ??= new Set<string>()) as Set<string>;
  if (t >= at && !fired.has(key)) {
    fired.add(key);
    f();
  }
};

/**
 * A part flicked off the item (spoon, pin ring, sticky liner, stim cap): it leaves along `v`
 * (item space, m/s), tumbles and is hidden after `life` s. Driven from the action's clock.
 */
function flyOff(part: THREE.Object3D | undefined, t0: number, now: number, v: THREE.Vector3, spin: THREE.Vector3, life = 0.35) {
  if (!part) return;
  if (!part.userData.rest) part.userData.rest = { p: part.position.clone(), q: part.quaternion.clone() };
  const rest = part.userData.rest as { p: THREE.Vector3; q: THREE.Quaternion };
  const dt = now - t0;
  if (t0 < 0 || dt < 0) {
    part.position.copy(rest.p);
    part.quaternion.copy(rest.q);
    part.visible = true;
    return;
  }
  part.visible = dt < life;
  part.position.copy(rest.p).addScaledVector(v, dt).add(V(0, -2.5 * dt * dt, 0));
  part.quaternion.copy(rest.q).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(spin.x * dt, spin.y * dt, spin.z * dt)));
}
/** a burning fuse on a cooking grenade: a flickering spark and a thin wisp (vm space) */
function fuseFx(item: THREE.Object3D, k: number, time: number) {
  let fx = item.getObjectByName('fuseFx') as THREE.Group | undefined;
  if (!fx) {
    if (k <= 0) return;
    fx = new THREE.Group();
    fx.name = 'fuseFx';
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.0035, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 2.6, 0.8), toneMapped: false, transparent: true }));
    glow.name = 'glow';
    fx.add(glow);
    for (let i = 0; i < 4; i++) {
      const w = new THREE.Mesh(new THREE.SphereGeometry(0.006, 6, 4), new THREE.MeshBasicMaterial({ color: 0x9a9890, transparent: true, opacity: 0.0, depthWrite: false }));
      w.name = 'wisp' + i;
      fx.add(w);
    }
    fx.position.set(0, 0.056, 0);
    fx.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).frustumCulled = false) : 0));
    item.add(fx);
  }
  fx.visible = k > 0;
  if (k <= 0) return;
  const glow = fx.getObjectByName('glow') as THREE.Mesh;
  (glow.material as THREE.MeshBasicMaterial).opacity = 0.6 + 0.4 * Math.sin(time * 61) * Math.sin(time * 37);
  glow.scale.setScalar(0.8 + 0.5 * Math.abs(Math.sin(time * 47)) + k * 0.6);
  for (let i = 0; i < 4; i++) {
    const w = fx.getObjectByName('wisp' + i) as THREE.Mesh;
    const u = (time * 1.4 + i / 4) % 1;
    w.position.set(Math.sin(time * 3 + i) * 0.01 * u, 0.06 * u, Math.cos(time * 2.3 + i) * 0.008 * u);
    w.scale.setScalar(0.6 + 2.2 * u);
    (w.material as THREE.MeshBasicMaterial).opacity = 0.32 * (1 - u) * Math.min(1, u * 5);
  }
}

/** the gun dropped out of the way (lethals) */
function gunDown(t: number, pos: THREE.Vector3, rot: THREE.Vector3, keys: [number, number][]) {
  const a = kf(t, keys);
  pos.y -= 0.38 * a;
  pos.x += 0.1 * a;
  pos.z += 0.05 * a;
  rot.x -= 1.0 * a;
  rot.z -= 0.45 * a;
  rot.y += 0.22 * a;
  return a;
}

// ============================================================================ lethals
/**
 * Right-hand overhand grenades: frag and sticky.
 *  frag    grab off the belt → the left fingers hook the ring and rip the pin out (the ring is
 *          flicked away) → arm cocked behind the ear, holding. Holding the key cooks it: the spoon
 *          flies off with a ping, the fuse spits and smokes, the hand starts to shake as the time
 *          runs down. The longer the key is held, the further the arm draws back (more power).
 *  sticky  grab → the left fingers pinch the tab of the liner over the adhesive pad and peel it
 *          off in one pull (it flutters away), the LED starts racing → cocked → throw.
 */
export function lethalGrenade(kind: 'frag' | 'sticky', t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: EqCtx) {
  const item = c.item();
  gunDown(t, pos, rot, [[0, 0], [0.12, 1], [0.86, 1], [1, 0]]);
  const pw = c.power, cook = Math.max(0, c.cook);
  // ---- right hand: belt → presented at the chest → cocked behind the ear (holds) → throw
  const fr = c.freeR;
  fr.b = kf(t, [[0, 0], [0.09, 1], [0.86, 1], [1, 0]]);
  kv(t, [
    [0, [0.14, -0.3, -0.2]], [0.12, [0.21, -0.38, -0.08]], [0.26, [0.07, -0.2, -0.28]], [0.4, [0.07, -0.195, -0.28]],
    [0.5, [0.15, -0.045, -0.26]], [0.52, [0.155, -0.04, -0.25]], [0.62, [0.04, -0.03, -0.55]], [0.74, [-0.01, -0.22, -0.42]], [1, [0.14, -0.3, -0.2]],
  ], fr.p);
  // the wind-up: more power draws the arm further back and higher
  const cocked = smoothstep(0.44, 0.52, t) * (1 - smoothstep(0.53, 0.6, t));
  fr.p.x += 0.02 * pw * cocked;
  fr.p.y += 0.025 * pw * cocked;
  fr.p.z += 0.06 * pw * cocked;
  // a live grenade in the fist: brought a little forward into view (you watch it burn), the hand
  // tightens and starts to tremble as the fuse runs down
  if (cook > 0) {
    const k = cocked * Math.min(1, cook * 6);
    fr.p.x -= 0.035 * k;
    fr.p.y -= 0.06 * k;
    fr.p.z -= 0.09 * k;
  }
  if (cook > 0 && cocked > 0.5) {
    const a = 0.0008 + 0.0035 * cook * cook;
    fr.p.x += Math.sin(c.time * 53) * a;
    fr.p.y += Math.sin(c.time * 41 + 1.3) * a;
  }
  fr.q.copy(handTrack(t,
    [[0, [-0.2, 0.3, -1]], [0.12, [0.1, -0.6, -0.6]], [0.26, [-0.35, 0.25, -1]], [0.4, [-0.35, 0.25, -1]], [0.5, [-0.05, 1, 0.25]], [0.52, [-0.05, 1, 0.3]], [0.62, [0.0, 0.3, -1]], [0.74, [-0.2, -0.6, -0.7]], [1, [-0.2, 0.3, -1]]],
    [[0, [-0.7, 0.4, -0.2]], [0.12, [-0.8, 0.2, 0.3]], [0.26, [-0.6, 0.65, 0.0]], [0.4, [-0.6, 0.65, 0.0]], [0.5, [-0.3, 0.0, -1]], [0.52, [-0.3, 0.0, -1]], [0.62, [-0.1, -0.5, -1]], [0.74, [-0.5, 0.4, -0.6]], [1, [-0.7, 0.4, -0.2]]]));
  // the grenade rides the right palm; fuse/top along the fingers, ring / pad facing the left hand
  const off = kind === 'frag' ? 0.03 : 0.026;
  const ps = itemFrom(c, 'R', fr.p, fr.q, off, [-Math.PI / 2, Math.PI, 0]);
  place(item, ps);
  item.visible = t > 0.1 && t < 0.62;
  item.userData.hand = 'R';
  c.setRPose(mixFP(POSES.hold, POSES.grip, smoothstep(0.1, 0.2, t) * (0.8 + 0.2 * cook)));
  // ---- left hand: up to the ring (or the liner tab), pull / peel, then out front for balance
  const fl = c.freeL;
  fl.b = kf(t, [[0, 0], [0.16, 0], [0.26, 1], [0.66, 1], [0.84, 0]]);
  const ring = ringRest(item);
  const liner = item.getObjectByName('liner');
  const target = kind === 'frag' ? ringWorld(item, ps) : V(0.03, -0.044, 0).applyQuaternion(ps.q).add(ps.p);
  const pullQ = handFrame(V(0.9, 0.15, -0.35), V(0.2, -1, 0.1));
  const reachQ = handFrame(V(0.8, 0.2, -0.5), V(0.3, -0.9, 0.2));
  const aimQ = handFrame(V(0.15, 0.25, -1), V(0.4, -0.2, -0.6));
  const grab = smoothstep(0.24, 0.3, t), pull = smoothstep(0.3, 0.38, t), away = smoothstep(0.42, 0.52, t);
  const qL = reachQ.clone().slerp(pullQ, grab).slerp(aimQ, away);
  // the fingertips go to the ring / tab; the wrist is solved back from there. The peel drags the
  // tab down and across, the pin pull straight out sideways.
  const tip = kind === 'frag' ? target.clone().add(V(-0.05 * pull, 0.014 * pull, 0.01 * pull)) : target.clone().add(V(-0.02 * pull, -0.05 * pull, 0.02 * pull));
  const wristOnTarget = c.wristAt('L', tip.clone().add(V(-0.02, 0.0, 0.035).applyQuaternion(qL)), qL, 0.0);
  const aimP = V(-0.15, -0.08, -0.44);
  fl.p.copy(wristOnTarget.lerp(aimP, away));
  fl.q.copy(qL);
  fl.pose = kind === 'frag' ? mixFP(POSES.open, FP_RING, grab * (1 - away)) : mixFP(POSES.open, FP_RING, grab * (1 - smoothstep(0.38, 0.42, t)));
  c.noWrapL();
  if (kind === 'frag') {
    if (ring) {
      // the ring rides the fingertip through the pull, then is flicked away down to the left
      if (t < 0.42) {
        ring.visible = true;
        if (pull > 0) ringTo(item, ps, pinchPoint(c, 'L', fl.p, fl.q));
        else if (ring.userData.rest) ring.position.copy(ring.userData.rest as THREE.Vector3);
      } else {
        const fly = (t - 0.42) * 1.4;
        ring.visible = fly < 0.25;
        if (ring.visible) ringTo(item, ps, pinchPoint(c, 'L', fl.p, fl.q).add(V(-0.25 * fly, -0.6 * fly, 0.05 * fly)));
      }
    }
    // holding the key at the ready cooks it: the spoon flies off with a ping, the fuse is lit
    if (c.held > 0.04 && c.data.spoonT === undefined && t < 0.6) {
      c.data.spoonT = c.time;
      c.ev('cookStart');
    }
    // spoon: flies off when the cook starts (or as it leaves the hand)
    const t0 = (c.data.spoonT as number | undefined) ?? -1;
    flyOff(item.getObjectByName('spoon'), t0, c.time, V(0.0, 0.35, 0.6), V(14, 3, 0), 0.4);
    fuseFx(item, t0 >= 0 && item.visible ? Math.max(0.15, cook) : 0, c.time);
  } else if (liner) {
    // peel: hinged at the far edge, the tab is pulled round and off, then dropped
    const peel = smoothstep(0.3, 0.4, t);
    liner.rotation.z = -2.6 * easeInOutCubic(peel);
    const gone = t > 0.42;
    if (gone) {
      if (c.data.linerT === undefined) c.data.linerT = c.time;
      flyOff(liner, c.data.linerT as number, c.time, V(-0.2, -0.5, 0.1), V(4, 2, 9), 0.3);
    } else {
      liner.visible = true;
      if (liner.userData.rest) liner.position.copy((liner.userData.rest as { p: THREE.Vector3 }).p);
    }
    const btn = item.getObjectByName('btn');
    if (btn) btn.position.y = 0.046;
    setLed(item.getObjectByName('led'), t > 0.4 ? (Math.sin(c.time * 30) > 0 ? 1 : 0.1) : 0);
  }
  once(c, 'a', t, 0.03, () => c.ev('cloth'));
  once(c, 'b', t, 0.13, () => c.ev('grab'));
  if (kind === 'frag') once(c, 'p', t, 0.34, () => { c.ev('pin'); c.jolt(0.12, 0.12); });
  else {
    once(c, 'k', t, 0.31, () => { c.ev('peel'); c.jolt(0.06, 0.05); });
    once(c, 'p', t, 0.4, () => c.ev('stickyArm'));
  }
  once(c, 'w', t, 0.55, () => c.ev(pw > 0.6 ? 'swishHeavy' : 'swish'));
  once(c, 'r', t, 0.61, () => {
    // not cooked: the spoon goes as it leaves the hand
    if (kind === 'frag' && c.data.spoonT === undefined) c.ev('spoon');
    c.ev('release');
  });
  once(c, 'z', t, 0.9, () => c.ev('cloth'));
}

/**
 * Throwing knife: the hand goes to the sheath on the chest rig, draws the knife up out of it
 * (blade scraping out), and brings it to the over-the-shoulder ready. Held there long enough, the
 * hand gets restless: a little toss, the knife spins once and is caught by the handle again.
 * On release: a quick wrist flick, no wind-up.
 */
export function lethalKnife(t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: EqCtx) {
  const item = c.item();
  gunDown(t, pos, rot, [[0, 0], [0.1, 1], [0.78, 1], [1, 0]]);
  const fr = c.freeR;
  fr.b = kf(t, [[0, 0], [0.06, 1], [0.8, 1], [1, 0]]);
  kv(t, [[0, [0.14, -0.3, -0.2]], [0.09, [0.0, -0.2, -0.17]], [0.15, [0.0, -0.2, -0.17]], [0.2, [0.04, -0.11, -0.2]], [0.28, [0.15, -0.035, -0.25]],
    [0.31, [0.155, -0.03, -0.245]], [0.36, [0.03, -0.04, -0.52]], [0.5, [-0.02, -0.2, -0.42]], [1, [0.14, -0.3, -0.2]]], fr.p);
  fr.q.copy(handTrack(t,
    [[0, [-0.2, 0.3, -1]], [0.09, [-0.2, -0.9, -0.2]], [0.15, [-0.2, -0.9, -0.2]], [0.2, [-0.3, 0.5, -0.8]], [0.28, [-0.1, 1, 0.3]], [0.31, [-0.1, 1, 0.35]], [0.36, [0.0, 0.1, -1]], [0.5, [-0.2, -0.6, -0.7]], [1, [-0.2, 0.3, -1]]],
    [[0, [-0.7, 0.4, -0.2]], [0.09, [-0.6, 0.1, -0.8]], [0.15, [-0.6, 0.1, -0.8]], [0.2, [-0.5, 0.0, -0.9]], [0.28, [-0.4, 0.0, -0.9]], [0.31, [-0.4, 0.0, -0.9]], [0.36, [-0.1, -0.7, -1]], [0.5, [-0.5, 0.4, -0.6]], [1, [-0.7, 0.4, -0.2]]]));
  // the draw: straight up out of the sheath along the blade
  const draw = smoothstep(0.12, 0.19, t);
  const shift = V(0, 0, -0.01 + 0.06 * (1 - draw) * (t < 0.2 ? 1 : 0));
  // spin-catch fidget while held: every ~2.6 s after the first second
  let spin = 0, toss = 0;
  if (c.held > 1.0) {
    const ph = ((c.held - 1.0) % 2.6) / 0.5;
    if (ph < 1) {
      spin = easeInOutCubic(ph) * Math.PI * 2;
      toss = Math.sin(ph * Math.PI) * 0.06;
      fr.p.y -= 0.01 * Math.sin(ph * Math.PI);
      once(c, 'spin' + Math.floor((c.held - 1.0) / 2.6), 1, 0, () => c.ev('knifeToss'));
      if (ph > 0.9) once(c, 'catch' + Math.floor((c.held - 1.0) / 2.6), 1, 0, () => c.ev('knifeCatch'));
    }
  }
  const ps = itemFrom(c, 'R', fr.p, fr.q, 0.008, [spin, Math.PI, 0], shift.add(V(0, 0, -toss)));
  place(item, ps);
  item.visible = t > 0.08 && t < 0.37;
  item.userData.hand = 'R';
  c.setRPose(toss > 0.02 ? POSES.open : FP_KNIFE);
  // left hand out front, aiming the throw
  const fl = c.freeL;
  fl.b = kf(t, [[0, 0], [0.16, 0], [0.24, 1], [0.48, 1], [0.66, 0]]);
  fl.p.set(-0.15, -0.09, -0.44);
  fl.q.copy(handFrame(V(0.15, 0.25, -1), V(0.4, -0.2, -0.6)));
  fl.pose = POSES.open;
  c.noWrapL();
  once(c, 'a', t, 0.02, () => c.ev('cloth'));
  once(c, 'd', t, 0.13, () => c.ev('knifeDraw'));
  once(c, 'w', t, 0.33, () => c.ev('knifeFlick'));
  once(c, 'r', t, 0.36, () => c.ev('release'));
}

/**
 * Picking a thrown knife back up (walked over it): a slow dip — the gun tips away, the right hand
 * reaches down to the ground in front, closes on the handle, brings it up and slides it home into
 * the chest sheath, and back to the grip.
 */
export function knifePickup(t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: EqCtx) {
  const item = c.item();
  gunDown(t, pos, rot, [[0, 0], [0.18, 0.75], [0.7, 0.75], [1, 0]]);
  // the whole view dips toward the ground
  pos.y -= 0.03 * kf(t, [[0, 0], [0.3, 1], [0.55, 1], [0.8, 0]]);
  const fr = c.freeR;
  fr.b = kf(t, [[0, 0], [0.12, 1], [0.82, 1], [1, 0]]);
  kv(t, [[0, [0.14, -0.3, -0.2]], [0.3, [0.06, -0.46, -0.42]], [0.4, [0.06, -0.47, -0.41]], [0.58, [0.02, -0.22, -0.25]], [0.68, [0.0, -0.2, -0.17]], [0.78, [0.0, -0.21, -0.17]], [1, [0.14, -0.3, -0.2]]], fr.p);
  fr.q.copy(handTrack(t,
    [[0, [-0.2, 0.3, -1]], [0.3, [-0.1, -0.6, -0.8]], [0.4, [-0.1, -0.6, -0.8]], [0.58, [-0.2, 0.6, -0.8]], [0.68, [-0.2, -0.9, -0.2]], [1, [-0.2, 0.3, -1]]],
    [[0, [-0.7, 0.4, -0.2]], [0.3, [-0.6, -0.3, 0.6]], [0.4, [-0.6, -0.3, 0.6]], [0.58, [-0.5, 0.0, -0.9]], [0.68, [-0.6, 0.1, -0.8]], [1, [-0.7, 0.4, -0.2]]]));
  const sheathe = smoothstep(0.66, 0.76, t);
  const ps = itemFrom(c, 'R', fr.p, fr.q, 0.008, [0, Math.PI, 0], V(0, 0, -0.01 + 0.06 * sheathe));
  place(item, ps);
  item.visible = t > 0.34 && t < 0.78;
  item.userData.hand = 'R';
  c.setRPose(t > 0.34 && t < 0.78 ? FP_KNIFE : POSES.open);
  once(c, 'a', t, 0.05, () => c.ev('cloth'));
  once(c, 'g', t, 0.36, () => c.ev('knifePickup'));
  once(c, 's', t, 0.7, () => c.ev('knifeSheath'));
}

/** C4: both hands, two-handed toss, then the gun comes back up and the left hand pulls the remote */
export function lethalC4(t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: EqCtx, gripItem: (side: 'L' | 'R', item: THREE.Object3D, marker: string, fingers: THREE.Vector3, palm: THREE.Vector3, r: number, pose: FingerPose) => void) {
  const stage2 = t >= 0.6;
  if (stage2 && c.data.stage !== 2) {
    c.data.stage = 2;
    c.hold('detonator');
  }
  const item = c.item();
  // the gun: down for the brick, back up in the right hand straight after the toss
  gunDown(t, pos, rot, [[0, 0], [0.13, 1], [0.58, 1], [0.78, 0]]);
  if (!stage2) {
    item.userData.twoHand = true;
    // both hands bring it up and arm it; at the ready the left lets go, the right drops it low
    // and back, then swings it forward underhand and snaps the wrist up — it leaves flat with
    // hard backspin (the wrist curls back over the top of it)
    const ip = kv(t, [[0, [0.0, -0.4, -0.26]], [0.18, [0.0, -0.13, -0.34]], [0.4, [0.0, -0.128, -0.34]], [0.44, [0.05, -0.2, -0.3]], [0.5, [0.07, -0.3, -0.22]], [0.56, [0.03, -0.12, -0.58]]]);
    ip.y += Math.sin(c.time * 2.2) * 0.002 * smoothstep(0.3, 0.4, t);
    ip.z -= 0.04 * c.power * smoothstep(0.5, 0.56, t);
    const flick = smoothstep(0.52, 0.56, t);
    const rx = kf(t, [[0, 0.6], [0.18, 0.3], [0.4, 0.3], [0.5, 0.75], [0.52, 0.6]]) - 2.4 * flick * flick;
    const ps: Pose = { p: ip, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, kf(t, [[0, 0], [0.42, 0], [0.5, -0.25], [0.56, 0]]))) };
    place(item, ps);
    item.visible = t > 0.03 && t < 0.565;
    c.freeR.b = kf(t, [[0, 0], [0.14, 1], [0.54, 1], [0.6, 0.5]]);
    c.freeL.b = kf(t, [[0, 0], [0.14, 1], [0.4, 1], [0.48, 0.0]]);
    const rel = smoothstep(0.55, 0.58, t);
    gripItem('L', item, 'gripL', V(0.15, -0.35, -1), V(1, 0, 0), 0.003, POSES.hold);
    gripItem('R', item, 'gripR', V(-0.15, -0.35, -1), V(-1, 0, 0), 0.003, rel > 0.4 ? POSES.open : POSES.hold);
    setLed(item.getObjectByName('led'), t < 0.36 ? (Math.sin(c.time * 18) > 0.4 ? 1 : 0) : 1);
  } else {
    // left hand: belt → the remote comes up into the ready hold (the gun hand is already back)
    item.userData.twoHand = false;
    item.userData.posed = false;
    const fl = c.freeL;
    fl.b = kf(t, [[0.6, 0.5], [0.66, 1], [1, 1]]);
    kv(t, [[0.6, [-0.12, -0.22, -0.38]], [0.72, [-0.2, -0.36, -0.2]], [0.88, [-0.14, -0.17, -0.27]], [1, [-0.14, -0.165, -0.27]]], fl.p);
    fl.q.copy(handFrame(V(0.35, 0.2, -1), V(1, 0.1, 0.35)));
    fl.pose = POSES.grip;
    item.visible = t > 0.74;
    const cover = item.getObjectByName('cover');
    if (cover) cover.rotation.x = 1.9 * smoothstep(0.9, 0.97, t);
    setLed(item.getObjectByName('led'), Math.sin(c.time * 9) > 0.6 ? 1 : 0.1);
  }
  once(c, 'a', t, 0.03, () => c.ev('cloth'));
  once(c, 'b', t, 0.3, () => c.ev('c4Arm'));
  once(c, 'w', t, 0.51, () => c.ev('swish'));
  once(c, 'r', t, 0.56, () => c.ev('release'));
  once(c, 'd', t, 0.8, () => c.ev('detDraw'));
  once(c, 'e', t, 0.92, () => c.ev('coverFlip'));
}

// ============================================================================ tacticals
/** left hand only; the gun stays up. Pin pulled by the left thumb; cocked back while the key is held. */
export function tacticalThrow(kind: string, t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: EqCtx) {
  const item = c.item();
  const snap = kind === 'snapshot' || kind === 'decoy';
  // the gun stays up in the right hand; how it is held one-handed depends on the gun
  const busy = kf(t, [[0, 0], [0.12, 1], [0.82, 1], [1, 0]]);
  const thr = Math.sin(smoothstep(0.55, 0.68, t) * Math.PI);
  if (c.cls === 'Pistol') {
    // pistol: drawn in close to the chest, canted in, muzzle still on target
    pos.x -= 0.035 * busy;
    pos.y -= 0.03 * busy;
    pos.z += 0.09 * busy;
    rot.z -= 0.32 * busy;
    rot.y -= 0.05 * busy;
  } else if (c.cls === 'LMG' && c.bipod > 0.5) {
    // LMG on its bipod: the gun stays planted, only the shoulder rolls off it for the throw
    pos.x += 0.006 * busy;
    rot.z -= 0.025 * busy;
  } else if (c.cls === 'LMG') {
    // heavy belt-fed off its bipod: it sags on the sling, butt on the hip
    pos.y -= 0.06 * busy;
    pos.x += 0.02 * busy;
    rot.x -= 0.16 * busy;
    rot.z -= 0.18 * busy;
  } else if (c.cls === 'Shotgun') {
    // shotgun: tucked under the arm, muzzle canted inboard
    pos.x += 0.03 * busy;
    pos.y -= 0.035 * busy;
    rot.y += 0.18 * busy;
    rot.z -= 0.22 * busy;
  } else {
    // rifles / SMGs: the body turns a touch to free the left arm
    pos.x += 0.016 * busy;
    pos.y -= 0.012 * busy;
    rot.z -= 0.06 * busy;
    rot.y -= 0.03 * busy;
    if (c.cls === 'Sniper' || c.cls === 'Marksman') rot.x -= 0.08 * busy;
  }
  // the throw rocks the shoulder and the gun with it
  rot.y += 0.035 * thr;
  rot.z += 0.03 * thr;
  const pw = c.power;
  const fl = c.freeL;
  fl.b = kf(t, [[0, 0], [0.12, 1], [0.84, 1], [1, 0]]);
  if (!snap) {
    // vest → presented → thumb in the ring, twist out → cocked high (holds) → overhand throw
    kv(t, [[0, [-0.17, -0.34, -0.24]], [0.13, [-0.22, -0.36, -0.15]], [0.27, [-0.13, -0.155, -0.31]], [0.42, [-0.125, -0.15, -0.31]],
      [0.5, [-0.17, -0.045, -0.27]], [0.55, [-0.175, -0.04, -0.26]], [0.62, [-0.05, -0.03, -0.55]], [0.76, [-0.08, -0.24, -0.42]], [1, [-0.17, -0.34, -0.24]]], fl.p);
    const ck = smoothstep(0.44, 0.5, t) * (1 - smoothstep(0.56, 0.6, t));
    fl.p.x -= 0.015 * pw * ck;
    fl.p.y += 0.02 * pw * ck;
    fl.p.z += 0.05 * pw * ck;
    const twist = Math.sin(smoothstep(0.32, 0.42, t) * Math.PI) * 0.7;
    const f = kv(t, [[0, [0.3, 0.2, -1]], [0.13, [0.3, -0.5, -0.8]], [0.27, [0.25, 0.35, -1]], [0.42, [0.25, 0.35, -1]], [0.5, [0.1, 1, 0.25]], [0.55, [0.1, 1, 0.3]], [0.62, [0.1, 0.2, -1]], [0.76, [0.2, -0.5, -0.8]], [1, [0.2, -0.3, -1]]]);
    const n = kv(t, [[0, [0.7, 0.6, 0]], [0.13, [0.8, 0.3, 0.4]], [0.27, [0.8, 0.5, 0.2]], [0.42, [0.8, 0.5, 0.2]], [0.5, [0.3, 0, -1]], [0.55, [0.3, 0, -1]], [0.62, [0.1, -0.5, -1]], [0.76, [0.5, 0.4, -0.6]], [1, [0.6, 0.6, 0]]]);
    n.applyAxisAngle(f.clone().normalize(), twist);
    fl.q.copy(handFrame(f, n));
    // thumb hooks the ring and stays curled through the pull, the fingers squeeze on the twist
    const hook = smoothstep(0.28, 0.33, t) * (1 - smoothstep(0.44, 0.5, t));
    fl.pose = t > 0.62 ? mixFP(POSES.hold, POSES.open, smoothstep(0.62, 0.66, t)) : mixFP(POSES.hold, FP_THUMBHOOK, hook);
    item.visible = t > 0.12 && t < 0.62;
    const ring = ringRest(item);
    if (ring) {
      const pull = smoothstep(0.34, 0.42, t);
      const rest = ring.userData.rest as THREE.Vector3;
      ring.position.copy(rest).add(V(0.03 * pull, 0.018 * pull, 0.012 * pull));
      ring.visible = t < 0.45;
    }
    // the spoon goes as it leaves the hand
    flyOff(item.getObjectByName('spoon'), t > 0.61 ? (c.data.spoonT as number | undefined) ?? (c.data.spoonT = c.time) : -1, c.time, V(0, 0.3, 0.5), V(12, 2, 0), 0.3);
    once(c, 'a', t, 0.03, () => c.ev('cloth'));
    once(c, 'p', t, 0.37, () => { c.ev('pin'); c.jolt(0.05, 0.08); });
    once(c, 'w', t, 0.57, () => c.ev('swishLight'));
    once(c, 'r', t, 0.61, () => { c.ev('release'); c.ev('spoon'); });
  } else {
    // snapshot: puck up flat in the palm, a firm wrist roll turns the cap a quarter (two detent
    // clicks, the sensor band lights), then held low and bowled underhand on release
    kv(t, [[0, [-0.12, -0.34, -0.26]], [0.14, [-0.21, -0.36, -0.14]], [0.28, [-0.105, -0.15, -0.31]], [0.42, [-0.105, -0.15, -0.31]],
      [0.5, [-0.17, -0.27, -0.16]], [0.55, [-0.175, -0.29, -0.14]], [0.64, [-0.06, -0.17, -0.55]], [0.78, [-0.08, -0.24, -0.42]], [1, [-0.12, -0.34, -0.26]]], fl.p);
    const tw = smoothstep(0.29, 0.41, t);
    const f = kv(t, [[0, [0.3, -0.2, -1]], [0.28, [0.2, 0.1, -1]], [0.42, [0.2, 0.1, -1]], [0.55, [0.2, -0.8, -0.4]], [0.64, [0.05, 0.3, -1]], [1, [0.3, -0.2, -1]]]);
    const n = kv(t, [[0, [0.4, 0.9, 0]], [0.28, [0.1, 1, 0.1]], [0.42, [0.1, 1, 0.1]], [0.55, [0.2, 0.3, -1]], [0.64, [0.0, 0.4, -1]], [1, [0.4, 0.9, 0]]]);
    n.applyAxisAngle(f.clone().normalize(), Math.sin(tw * Math.PI) * 1.0);
    fl.q.copy(handFrame(f, n));
    fl.pose = t > 0.64 ? POSES.open : mixFP(POSES.hold, POSES.grip, Math.sin(tw * Math.PI));
    item.visible = t > 0.12 && t < 0.64;
    const cap = item.getObjectByName('cap');
    if (cap) cap.rotation.y = -Math.PI / 2 * easeInOutCubic(tw);
    if (kind === 'decoy') {
      // the decoy's top section is the dial: the twist arms it (LED wakes up)
      const r = item.getObjectByName('ring');
      if (r) r.visible = false;
      setLed(item.getObjectByName('led'), t > 0.4 ? (Math.sin(c.time * 16) > 0 ? 1 : 0.2) : 0);
    }
    // bowled low: the hand drops further for a stronger roll
    const low = smoothstep(0.46, 0.53, t) * (1 - smoothstep(0.56, 0.62, t));
    fl.p.y -= 0.03 * pw * low;
    fl.p.z += 0.03 * pw * low;
    const ringM = item.getObjectByName('ring') as THREE.Mesh | undefined;
    if (ringM) (ringM.material as THREE.MeshBasicMaterial).color.setRGB(0.15, 0.45, 0.9).multiplyScalar(t > 0.4 ? 1.5 + 2.5 * (0.5 + 0.5 * Math.sin(c.time * 14)) : 0.4);
    once(c, 'a', t, 0.03, () => c.ev('cloth'));
    once(c, 't1', t, 0.33, () => c.ev('twist'));
    once(c, 't2', t, 0.39, () => c.ev('twist'));
    once(c, 'p', t, 0.41, () => c.ev(kind === 'decoy' ? 'decoyArm' : 'snapArm'));
    once(c, 'w', t, 0.58, () => c.ev('swishLight'));
    once(c, 'r', t, 0.63, () => c.ev('release'));
  }
  void clamp;
}

/** detonator press from the ready hold: thumb flips the cover, clacks the button */
export function detPress(t: number, pos: THREE.Vector3, rot: THREE.Vector3, c: EqCtx) {
  const item = c.item();
  const fl = c.freeL;
  fl.b = 1;
  // the thumb comes up high over the button, then slams it (the whole fist kicks down with it)
  const clack = smoothstep(0.42, 0.46, t) * (1 - smoothstep(0.52, 0.72, t));
  const raise = smoothstep(0.25, 0.4, t) * (1 - smoothstep(0.42, 0.46, t));
  fl.p.set(-0.14, -0.165 + 0.014 * Math.sin(Math.min(1, t * 2) * Math.PI) + 0.006 * raise - 0.016 * clack, -0.27 + 0.008 * clack);
  fl.q.copy(handFrame(V(0.35, 0.2, -1), V(1, 0.1, 0.35)));
  fl.pose = POSES.grip;
  item.visible = true;
  const cover = item.getObjectByName('cover');
  if (cover) cover.rotation.x = 1.9 * smoothstep(0.1, 0.3, t);
  const btn = item.getObjectByName('button');
  if (btn) btn.position.y = 0.0485 - 0.004 * clack;
  setLed(item.getObjectByName('led'), t > 0.45 ? 1 : Math.sin(c.time * 9) > 0.6 ? 1 : 0.1);
  pos.x += 0.012;
  rot.z -= 0.05;
  pos.y -= 0.006 * clack;
  if (!(c.data.coverUp as boolean)) once(c, 'f', t, 0.15, () => c.ev('coverFlip'));
  once(c, 'd', t, 0.45, () => { c.ev('detonate'); c.jolt(0.45, 0.32); });
}
