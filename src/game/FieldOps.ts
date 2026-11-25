import * as THREE from 'three';
import { Combatant, HitPart } from './Combatant';
import { Bot, PLATE_HP } from '../ai/Bot';
import { NETF } from '../net/NetFlags';
import { clamp } from '../core/math';

/**
 * Update 47 — the field: what happens between being hit and dying.
 *
 * Downed: lethal damage that is not a headshot, a blade or a point-blank blast puts a soldier on
 * the ground instead of killing them: on their back, propped on an elbow, crawling, calling for a
 * medic. They bleed out unless a teammate gets to them. Shooting a downed soldier finishes them.
 * A second fall soon after a revive is fatal.
 *
 * Revive: a teammate kneels, packs the wound and jabs a stim — 3.4 s (a medic 1.7 s) of holding
 * still. Under fire, bots first drag the casualty a few metres into cover by the vest strap.
 * You do the same: hold [F] over a downed teammate to revive, tap [F] to grab and drag them.
 *
 * Plates: two ceramic plates in every carrier plus spares in the pouches. Torso hits land on the
 * plates first (Combatant.plateAbsorb); a plate that breaks bursts in ceramic grit with a crack you
 * hear. [O] slides a spare in (hold to keep going). Bots re-plate in cover.
 */

type G = any;

export const DOWN = {
  /** extra life while down (shots finish you) */
  hp: 50,
  /** seconds to bleed out (dragging slows it, a revive in progress stops it) */
  bleed: 28,
  revive: 3.4,
  reviveMedic: 1.7,
  /** health when back up */
  upHp: 35,
  upHpMedic: 75,
  /** a second fall inside this window after a revive is fatal */
  again: 15,
};

export type Role = 'rifleman' | 'medic' | 'support' | 'recon';
export const ROLES: { id: Role; name: string; desc: string; perks: string[] }[] = [
  { id: 'rifleman', name: 'RIFLEMAN', desc: 'Front-line soldier. Carries the most plates and slides them in fastest.', perks: ['5 spare plates (others 3)', 'Re-plates 30 % faster', 'Lethal +1'] },
  { id: 'medic', name: 'MEDIC', desc: 'Keeps the squad in the fight: revives in half the time and brings people back strong.', perks: ['Revive 1.7 s (others 3.4 s)', 'Revived teammates get 75 HP', 'Heals squadmates near you'] },
  { id: 'support', name: 'SUPPORT', desc: 'Ammunition and equipment for the squad: resupplies everyone near you.', perks: ['Squadmates within 12 m slowly refill ammo', 'Field upgrade charges 35 % faster', 'Spare magazine for both guns'] },
  { id: 'recon', name: 'RECON', desc: 'Eyes for the team: spots further, hears more, marks what it sees.', perks: ['Spotting marks last twice as long', 'Enemy footsteps louder', 'Radar Pulse reaches 40 % further'] },
];

interface Casualty {
  c: Combatant;
  by: Combatant | null;
  weapon: string;
  bleed: number;
  prog: number;
  reviver: Combatant | null;
  /** seconds since a reviver last worked (the progress decays back if they stop) */
  idle: number;
  draggedBy: Combatant | null;
  t: number;
}

export class FieldOps {
  cas: Casualty[] = [];
  /** match counters (tests, balance) */
  stats = { downs: 0, revives: 0, bleeds: 0, plateBreaks: 0 };
  private lastUp = new Map<Combatant, number>();
  private assignT = 0;
  /** player: the casualty you are working on / dragging */
  private myRevive: Casualty | null = null;
  private myDrag: Casualty | null = null;
  private fHeld = 0;
  private giveUpT = 0;
  /** your downed state (HUD) */
  me: Casualty | null = null;
  private plateKeyHeld = false;
  role: Role = 'rifleman';
  private auraT = 0;

  constructor(private g: G) {}

  get enabled() {
    return !this.g.sab && !NETF.active;
  }

  // ================================================================ going down
  /**
   * Lethal damage arrived. Returns true when the soldier goes down instead of dying (their health is
   * now the downed pool; the caller must not kill them).
   */
  tryDown(c: Combatant, by: Combatant | null, part: HitPart | null, cls: string, dmg: number, weapon: string) {
    if (!this.enabled || c.downed || !c.alive) return false;
    if (part === 'head' || cls === 'Melee' || cls === 'Sniper') return false;
    if (cls === 'Explosive' && dmg > 135) return false;
    if (c instanceof Bot && (c.netPuppet || c.netDisabled)) return false;
    const last = this.lastUp.get(c);
    if (last !== undefined && this.g.time - last < DOWN.again) return false;
    c.downed = true;
    c.health = DOWN.hp;
    this.stats.downs++;
    const cs: Casualty = { c, by, weapon, bleed: DOWN.bleed, prog: 0, reviver: null, idle: 0, draggedBy: null, t: 0 };
    this.cas.push(cs);
    if (c instanceof Bot) c.goDown();
    if (c === this.g.avatar) this.playerDown(cs);
    // the feed and the shooter's reward
    this.g.match.feed.unshift({ killer: by?.name ?? '', killerTeam: by?.team ?? c.team, victim: c.name, victimTeam: c.team, weapon, headshot: false, wallbang: false, t: this.g.time, kind: 'down' });
    if (this.g.match.feed.length > 6) this.g.match.feed.pop();
    if (by && by !== c && by.team !== c.team) by.score += 50;
    if (by === this.g.avatar) {
      this.g.ui.killText(50, ['ENEMY DOWNED']);
      this.g.audio.play('hit', { gain: 0.8, rate: 0.82, bus: 'ui', reverb: 0, prio: 3 });
      this.g.audio.play('imp_punch', { gain: 0.25, bus: 'ui', reverb: 0, rate: 0.9 });
    }
    // a nearby teammate shouts it
    const mate = this.g.bots.find((b: Bot) => b.alive && !b.downed && b !== c && b.team === c.team && b.position().distanceTo(c.position()) < 28);
    if (mate && Math.random() < 0.7) this.g.botVoice(mate, 'mandown');
    this.g.bloodPool?.(c);
    return true;
  }

  /** a downed soldier was finished off (or died): forget them */
  forget(c: Combatant) {
    const i = this.cas.findIndex((x) => x.c === c);
    if (i < 0) return;
    const cs = this.cas[i];
    if (cs.draggedBy instanceof Bot) cs.draggedBy.task = null;
    if (cs === this.myDrag) this.stopDrag();
    if (cs === this.myRevive) this.stopRevive();
    if (cs === this.me) this.playerUpCleanup();
    this.cas.splice(i, 1);
    c.downed = false;
  }

  private bleedOut(cs: Casualty) {
    const c = cs.c;
    this.stats.bleeds++;
    this.forget(c);
    c.health = 0;
    c.alive = false;
    const killer = cs.by && cs.by.team !== c.team ? cs.by : c;
    this.g.onKill(killer, c, cs.weapon, false, false);
    if (c === this.g.avatar) {
      this.g.killerName = killer === c ? 'BLED OUT' : killer.name.toUpperCase();
      this.g.killerWeapon = cs.weapon.toUpperCase();
    }
  }

  /** back on their feet */
  private revived(cs: Casualty, by: Combatant | null) {
    const c = cs.c;
    const medic = by === this.g.avatar ? this.role === 'medic' : by instanceof Bot && by.personality === 'medic';
    this.stats.revives++;
    this.forget(c);
    c.health = medic ? DOWN.upHpMedic : DOWN.upHp;
    this.lastUp.set(c, this.g.time);
    if (c instanceof Bot) c.getUp();
    if (c === this.g.avatar) this.playerUp(by);
    this.g.match.feed.unshift({ killer: by?.name ?? '', killerTeam: c.team, victim: c.name, victimTeam: c.team, weapon: '', headshot: false, wallbang: false, t: this.g.time, kind: 'revive' });
    if (this.g.match.feed.length > 6) this.g.match.feed.pop();
    if (by) by.score += 100;
    if (by === this.g.avatar) {
      this.g.ui.killText(100, [`REVIVED ${c.name.toUpperCase()}`]);
      this.g.audio.play('uiConfirm', { gain: 0.5, bus: 'ui', reverb: 0 });
    }
    // the stim hiss and a gasp
    this.g.audio.play('stimInject', { pos: c.position(), gain: 0.55, ref: 3, reverb: 0.1 });
  }

  // ================================================================ the frame
  update(dt: number) {
    const g = this.g;
    if (!this.enabled) {
      if (this.cas.length) for (const cs of [...this.cas]) this.forget(cs.c);
      return;
    }
    for (let i = this.cas.length - 1; i >= 0; i--) {
      const cs = this.cas[i];
      const c = cs.c;
      if (!c.alive || !c.downed) {
        this.forget(c);
        continue;
      }
      cs.t += dt;
      cs.idle += dt;
      // a stalled revive drains back
      if (cs.idle > 0.4 && cs.prog > 0) cs.prog = Math.max(0, cs.prog - dt * 0.35);
      if (cs.idle > 0.4) cs.reviver = null;
      const working = cs.idle < 0.25;
      cs.bleed -= dt * (working ? 0 : cs.draggedBy ? 0.5 : 1);
      if (cs.bleed <= 0) this.bleedOut(cs);
    }
    // send teammates to the wounded (twice a second)
    this.assignT -= dt;
    if (this.assignT <= 0) {
      this.assignT = 0.5;
      this.assignRevivers();
    }
    this.playerInteract(dt);
    this.updateMe(dt);
    this.roleAura(dt);
    this.playerPlates(dt);
    void g;
  }

  /** the nearest free teammate goes to each casualty; under fire they drag them into cover first */
  private assignRevivers() {
    const g = this.g;
    for (const cs of this.cas) {
      const c = cs.c;
      if (cs.draggedBy === g.avatar || cs.reviver === g.avatar) continue;
      const taken = g.bots.some((b: Bot) => b.task && b.task.who === c);
      if (taken) continue;
      // the player is nearer and coming? leave it to them
      if (c.team === g.avatar.team && g.avatar.alive && !g.avatar.downed && g.player.pos.distanceTo(c.position()) < 6) continue;
      let best: Bot | null = null;
      let bd = 1e9;
      for (const b of g.bots as Bot[]) {
        if (!b.alive || b.downed || b.team !== c.team || b.task || b.netPuppet || b.netDisabled) continue;
        const d = b.position().distanceTo(c.position());
        const range = b.personality === 'medic' ? 70 : 42;
        if (d > range) continue;
        // in a firefight with a visible enemy close by: not now (medics go anyway)
        const busy = b.state === 'engage' && b.personality !== 'medic' && d > 8;
        const score = d * (b.personality === 'medic' ? 0.5 : 1) + (busy ? 40 : 0);
        if (score < bd) {
          bd = score;
          best = b;
        }
      }
      if (!best || bd > 60) continue;
      // under fire: haul them into cover first (a cover spot near the casualty, away from the shooter)
      let dest: THREE.Vector3 | null = null;
      const threat = cs.by && cs.by.alive ? cs.by.position() : null;
      if (threat && best.suppression > 0.2 || (threat && threat.distanceTo(c.position()) < 35 && g.physics.lineOfSight(threat.clone().setY(threat.y + 1.5), c.position().clone().setY(c.position().y + 0.4)))) {
        dest = this.coverNear(c.position(), threat!);
      }
      best.task = { kind: dest ? 'drag' : 'revive', who: c, dest, t: 0, grabbed: false, started: false, drag: 0 };
      if (Math.random() < 0.7) g.botVoice(best, 'onMyWay');
    }
  }

  /** a nav node 2–7 m away with a wall between it and the threat */
  private coverNear(p: THREE.Vector3, threat: THREE.Vector3) {
    const g = this.g;
    const nodes = g.nav.nodes as { p: THREE.Vector3 }[];
    let best: THREE.Vector3 | null = null;
    let bd = 1e9;
    for (const n of nodes) {
      const d = n.p.distanceTo(p);
      if (d < 2 || d > 7.5) continue;
      if (g.physics.lineOfSight(threat.clone().setY(threat.y + 1.5), n.p.clone().setY(n.p.y + 0.5))) continue;
      if (d < bd) {
        bd = d;
        best = n.p.clone();
      }
    }
    return best;
  }

  // ================================================================ bot hooks
  reviveTick(bot: Bot, who: Combatant, dt: number) {
    const cs = this.cas.find((x) => x.c === who);
    if (!cs) return 1;
    cs.reviver = bot;
    cs.idle = 0;
    const T = bot.personality === 'medic' ? DOWN.reviveMedic : DOWN.revive;
    if (cs.prog === 0 && who === this.g.avatar) this.g.ui.notify(`${bot.name.toUpperCase()} IS REVIVING YOU`, 'HOLD ON');
    cs.prog = Math.min(1, cs.prog + dt / T);
    if (cs.prog >= 1) {
      this.revived(cs, bot);
      return 1;
    }
    return cs.prog;
  }
  drag(bot: Bot, who: Combatant, to: THREE.Vector3, yaw: number) {
    const cs = this.cas.find((x) => x.c === who);
    if (!cs) return;
    cs.draggedBy = bot;
    if (who instanceof Bot) {
      who.dragTo = (who.dragTo ?? new THREE.Vector3()).copy(to);
      who.dragYaw = yaw;
    } else if (who === this.g.avatar) {
      // you are being hauled: the body follows the dragger (physics bypassed for the frame)
      const pl = this.g.player;
      const p = pl.pos.clone().lerp(to, 0.25);
      pl.body.teleport(p);
    }
  }
  dragEnd(bot: Bot, who: Combatant) {
    const cs = this.cas.find((x) => x.c === who);
    if (cs && cs.draggedBy === bot) cs.draggedBy = null;
    if (who instanceof Bot) who.dragTo = null;
  }

  // ================================================================ the player, downed
  private playerDown(cs: Casualty) {
    const g = this.g;
    this.me = cs;
    g.player.downed = true;
    g.weapons.downedLock = true;
    if (g.weapons.current !== 1) g.weapons.switchTo(1);
    g.player.sprinting = false;
    g.vm.detonatorOut = false;
    g.ui.downed?.(true);
    g.audio.play('bodyfall', { gain: 0.8, reverb: 0.05 });
    g.audio.play('imp_punch', { gain: 0.5, rate: 0.7, bus: 'ui', reverb: 0 });
    g.rig?.addTrauma?.(0.55);
    g.playerVoice?.('hurt', 1);
    this.giveUpT = 0;
  }
  private playerUp(by: Combatant | null) {
    const g = this.g;
    this.playerUpCleanup();
    g.ui.notify('BACK ON YOUR FEET', by ? `REVIVED BY ${by.name.toUpperCase()}` : '');
    g.audio.play('breathIn', { gain: 0.6, reverb: 0 });
    g.rig?.addTrauma?.(0.25);
    g.weapons.switchTo(0);
  }
  private playerUpCleanup() {
    const g = this.g;
    this.me = null;
    g.player.downed = false;
    g.weapons.downedLock = false;
    g.ui.downed?.(false);
  }

  private updateMe(dt: number) {
    const g = this.g;
    const cs = this.me;
    if (!cs) return;
    // hold [F] to give up (bleed out now)
    if (g.input.isDown('spot')) {
      this.giveUpT += dt;
      if (this.giveUpT > 1.4) {
        cs.bleed = 0;
        this.bleedOut(cs);
        return;
      }
    } else this.giveUpT = 0;
    // who is coming
    const helper = g.bots.find((b: Bot) => b.task && b.task.who === cs.c) as Bot | undefined;
    const hd = helper ? helper.position().distanceTo(g.player.pos) : -1;
    g.ui.downedState?.({
      bleed: cs.bleed / DOWN.bleed,
      secs: Math.ceil(cs.bleed),
      prog: cs.prog,
      helper: helper ? helper.name.toUpperCase() : '',
      dist: hd,
      giveUp: this.giveUpT / 1.4,
      dragged: !!cs.draggedBy,
    });
  }

  // ================================================================ the player, helping
  /** the downed teammate you are looking at, in reach */
  private focus() {
    const g = this.g;
    if (!g.avatar.alive || g.avatar.downed) return null;
    const eye = g.camera.position as THREE.Vector3;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(g.camera.quaternion);
    let best: Casualty | null = null;
    let bs = -1;
    for (const cs of this.cas) {
      if (cs.c.team !== g.avatar.team || cs.c === g.avatar) continue;
      const p = cs.c.position().clone().setY(cs.c.position().y + 0.3);
      const to = p.clone().sub(eye);
      const d = Math.hypot(to.x, to.z);
      if (d > 2.4) continue;
      const dot = to.normalize().dot(fwd);
      if (dot < 0.35 && d > 1.2) continue;
      const s = dot - d * 0.2;
      if (s > bs) {
        bs = s;
        best = cs;
      }
    }
    return best;
  }

  /** prompt under the crosshair */
  hint(): string {
    if (this.myDrag) return '[F] LET GO  ·  HOLD [F] REVIVE';
    if (this.myRevive) return '';
    if (this.me) return '';
    const f = this.focus();
    if (f) return `HOLD [F] REVIVE ${f.c.name.toUpperCase()}  ·  TAP [F] DRAG`;
    return '';
  }
  /** F belongs to us right now (doors / spotting must not take it) */
  usesF() {
    return !!(this.me || this.myDrag || this.myRevive || this.focus());
  }

  private playerInteract(dt: number) {
    const g = this.g;
    const inp = g.input;
    if (!g.avatar.alive || this.me) {
      if (this.myDrag) this.stopDrag();
      if (this.myRevive) this.stopRevive();
      return;
    }
    const down = inp.isDown('spot');
    if (inp.wasPressed('spot')) this.fHeld = 0;
    if (down) this.fHeld += dt;
    // dragging: the body hangs off your left hand a metre ahead while you walk backwards
    if (this.myDrag) {
      const cs = this.myDrag;
      if (!cs.c.alive || !cs.c.downed) return this.stopDrag();
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(g.camera.quaternion).setY(0).normalize();
      const at = g.player.pos.clone().addScaledVector(fwd, 1.0);
      at.y = g.player.pos.y;
      // keep the body on the ground it is being pulled over
      const gy = g.groundHeightAt ? g.groundHeightAt(at.x, at.z) : at.y;
      if (Math.abs(gy - at.y) < 1.2) at.y = Math.max(at.y, gy);
      if (cs.c instanceof Bot) {
        cs.c.dragTo = (cs.c.dragTo ?? new THREE.Vector3()).copy(at);
        cs.c.dragYaw = Math.atan2(-fwd.x, -fwd.z);
      }
      cs.draggedBy = g.avatar;
      g.player.busyCap = 1.9;
      // tap [F] again: let go; hold [F]: let go and start the revive
      if (inp.wasReleased('spot') && this.fHeld < 0.25) this.stopDrag();
      else if (down && this.fHeld > 0.3) {
        const c = cs;
        this.stopDrag();
        this.startRevive(c);
      }
      return;
    }
    if (this.myRevive) {
      const cs = this.myRevive;
      if (!cs.c.alive || !cs.c.downed || !down || cs.c.position().distanceTo(g.player.pos) > 2.8) return this.stopRevive();
      cs.reviver = g.avatar;
      cs.idle = 0;
      const T = this.role === 'medic' ? DOWN.reviveMedic : DOWN.revive;
      cs.prog = Math.min(1, cs.prog + dt / T);
      g.player.busyCap = 0;
      g.ui.actionRing(cs.prog, `REVIVING ${cs.c.name.toUpperCase()}`, 'revive');
      if (cs.prog >= 1) {
        this.revived(cs, g.avatar);
        this.stopRevive();
      }
      return;
    }
    const f = this.focus();
    if (!f) return;
    if (down && this.fHeld > 0.22) this.startRevive(f);
    else if (inp.wasReleased('spot') && this.fHeld <= 0.22) this.startDrag(f);
  }

  private startRevive(cs: Casualty) {
    const g = this.g;
    this.myRevive = cs;
    // hands on: the gun goes away, kneel over them
    g.player.sprinting = false;
    g.player.busyCap = 0;
    g.player.kneel(true);
    g.vm.holdItem('stim');
    g.vm.play('revive', 1.6, [], undefined, { holdAt: 0.82, hold: () => !!this.myRevive });
    g.audio.play('cloth', { gain: 0.6, reverb: 0 });
    if (Math.random() < 0.6) g.playerVoice?.('reviving', 1);
  }
  private stopRevive() {
    const g = this.g;
    if (this.myRevive) g.player.kneel(false);
    this.myRevive = null;
    g.player.busyCap = -1;
    g.ui.actionRing(null);
  }
  private startDrag(cs: Casualty) {
    const g = this.g;
    if (cs.draggedBy instanceof Bot) cs.draggedBy.task = null;
    this.myDrag = cs;
    g.player.sprinting = false;
    g.vm.play('dragBody', 1.2, [], undefined, { holdAt: 0.5, hold: () => !!this.myDrag });
    g.audio.play('cloth', { gain: 0.7, reverb: 0 });
    g.audio.play('bodyfall', { gain: 0.25, rate: 1.4, reverb: 0 });
  }
  private stopDrag() {
    const g = this.g;
    const cs = this.myDrag;
    this.myDrag = null;
    g.player.busyCap = -1;
    if (cs) {
      if (cs.c instanceof Bot) cs.c.dragTo = null;
      if (cs.draggedBy === g.avatar) cs.draggedBy = null;
    }
  }
  /** true while your hands are busy with a casualty (the game blocks firing / equipment) */
  get handsBusy() {
    return !!(this.myDrag || this.myRevive);
  }

  // ================================================================ roles
  /** medic: squadmates near you heal; support: they (and you) slowly refill ammo */
  private roleAura(dt: number) {
    const g = this.g;
    this.auraT -= dt;
    if (this.auraT > 0 || !g.avatar.alive) return;
    this.auraT = 1;
    const me = g.player.pos as THREE.Vector3;
    for (const b of g.bots as Bot[]) {
      if (!b.alive || b.downed || b.team !== g.avatar.team || b.position().distanceTo(me) > 12) continue;
      if (this.role === 'medic' && b.health < 100) b.health = Math.min(100, b.health + 6);
      if (this.role === 'support') b.spare = Math.min(3, b.spare + 0.08);
    }
    if (this.role === 'support') {
      for (const sl of g.weapons.slots) if (sl.reserve < sl.def.reserve * 1.5) sl.reserve = Math.min(sl.def.reserve * 1.5, sl.reserve + Math.max(1, Math.round(sl.def.mag * 0.06)));
    }
  }

  // ================================================================ plates
  /** fill a soldier's carrier for a fresh life */
  issuePlates(c: Combatant, role: Role | 'bot') {
    if (!this.enabled) {
      c.plates = [];
      c.spare = 0;
      return;
    }
    // soldiers carry a little less ceramic than you (keeps 12-a-side fights moving)
    c.plates = role === 'bot' ? [PLATE_HP * 0.7, PLATE_HP * 0.7] : [PLATE_HP, PLATE_HP];
    c.spare = role === 'rifleman' ? 5 : role === 'bot' ? 1 : 3;
  }
  /** a torso hit landed on a plate (or broke it): grit, sparks, the crack */
  plateHit(c: Combatant, point: THREE.Vector3, dir: THREE.Vector3, broke: boolean, byMe = false) {
    const g = this.g;
    if (broke) this.stats.plateBreaks++;
    if (c === g.avatar) {
      // your own plate: the crack in your chest, the HUD segment flashes
      g.audio.play(broke ? 'plateBreak' : 'plateHit', { gain: broke ? 0.9 : 0.5, bus: 'ui', reverb: 0.02, vary: 0.06 });
      g.ui.plateFlash?.(broke);
      if (broke) {
        g.rig?.addTrauma?.(0.18);
        g.ui.notify('PLATE BROKEN', '[O] NEW PLATE');
      }
      return;
    }
    const d = point.distanceTo(g.camera.position);
    if (d < 90) {
      // ceramic dust and chips off the strike face
      const n = dir.clone().negate();
      for (let i = 0; i < (broke ? 14 : 5); i++) {
        const v = n.clone().multiplyScalar(1 + Math.random() * 2.5).add(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.6, (Math.random() - 0.5) * 2));
        g.fx.sparks.spawn(point, v, broke ? [2.6, 2.4, 2.1] : [1.8, 1.6, 1.3], 1, 0.012 + Math.random() * 0.01, 0.25 + Math.random() * 0.3, { drag: 2, grav: 6, grow: 0 });
      }
      g.fx.smoke.spawn(point.clone(), n.clone().multiplyScalar(0.6), [0.78, 0.76, 0.72], broke ? 0.5 : 0.25, 0.12, broke ? 1.2 : 0.7, { drag: 2, grav: -0.2, grow: 0.9 });
      g.audio.play(broke ? 'plateBreak' : 'plateHit', { pos: point, gain: broke ? 0.9 : 0.6, ref: 4, reverb: 0.1, vary: 0.08 });
    }
    // the shooter knows: a blue-grey armour marker, a heavier one when it breaks
    if (byMe) {
      g.ui.hitmarker(false, false, 10, broke ? 'plateBreak' : 'plate');
      g.audio.play(broke ? 'plateBreak' : 'plateHit', { gain: broke ? 0.55 : 0.35, bus: 'ui', reverb: 0, rate: 1.15 });
    }
  }

  /** [O]: a plate out of the pouch and into the carrier (hold to do every empty slot) */
  private playerPlates(dt: number) {
    const g = this.g;
    const a = g.avatar as Combatant;
    if (!a.alive || this.me || !a.plates) return;
    const inp = g.input;
    const want = inp.wasPressed('plate') || (this.plateKeyHeld && inp.isDown('plate'));
    this.plateKeyHeld = inp.isDown('plate');
    const busy = g.weapons.switching || g.weapons.reloading || g.vm.action || this.handsBusy;
    if (!want || busy) return;
    const i = a.plates.findIndex((h) => h < PLATE_HP);
    if (i < 0) {
      if (inp.wasPressed('plate')) g.ui.notify('PLATES', 'CARRIER FULL');
      return;
    }
    if ((a.spare ?? 0) <= 0) {
      if (inp.wasPressed('plate')) g.ui.notify('NO PLATES', 'RESUPPLY AT AN AMMO CRATE');
      return;
    }
    const fast = this.role === 'rifleman' ? 0.7 : 1;
    g.player.sprinting = false;
    g.vm.holdItem('plate');
    g.vm.play('plate', 1.05 * fast, []);
  }
  /** the 'plateIn' beat of the animation */
  plateIn() {
    const g = this.g;
    const a = g.avatar as Combatant;
    if (!a.plates || (a.spare ?? 0) <= 0) return;
    const i = a.plates.findIndex((h) => h < PLATE_HP);
    if (i < 0) return;
    a.plates[i] = PLATE_HP;
    a.spare = (a.spare ?? 1) - 1;
    g.ui.plateFlash?.(false, true);
  }

  /** HUD numbers */
  plateState(c: Combatant) {
    return { plates: (c.plates ?? []).map((h) => clamp(h / PLATE_HP, 0, 1)), spare: Math.floor(c.spare ?? 0) };
  }

  reset() {
    for (const cs of [...this.cas]) this.forget(cs.c);
    this.lastUp.clear();
    this.stopDrag();
    this.stopRevive();
    this.playerUpCleanup();
  }
}
