import * as THREE from 'three';
import type { Game } from './Game';
import type { Combatant } from './Combatant';
import { Bot } from '../ai/Bot';
import { Sabotage, SabHooks, Seat, Kit, Nade, NADES, defaultKit, RoundEnd, BUY_TIME, FUSE, PLANT_TIME, DEFUSE_TIME, DEFUSE_KIT, WIRE_OPEN, bountyFor, SHOP } from './Sabotage';
import { SabUI, Portrait, kr, WIRE_NAMES } from '../ui/SabUI';
import { SabBrain } from '../ai/SabBrain';
import { SV_SPAWNS, SV_SITES, AREA, Rect } from '../world/maps/Solvik';
import { WEAPONS, WeaponDef } from '../weapons/WeaponDefs';
import { WEAPON_BUILDERS, WeaponId } from '../weapons/WeaponModels';
import { makeCharge, setLed } from '../weapons/EquipmentModels';
import { bakeFlat } from '../render/Batch';
import { NETF } from '../net/NetFlags';

/**
 * Sabotasje in the game (Update 42): wires the round rules (Sabotage) to the world, the player,
 * the bots (SabBrain) and the HUD (SabUI). Owns the things only this mode has: the charge in the
 * world (on a back, dropped, planted and beeping), guns lying on the ground, firebomb fires, the
 * buy menu, plant / defuse input and the wire gamble, spectating your team, the round flow audio.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type G = any;
export type { Game };

/** the charge going off: hurts everyone (no team is safe from it) */
const CHARGE_DEF = { id: 'charge', name: 'Sprengladning', cls: 'Explosive' } as unknown as WeaponDef;
const FIRE_DEF = { id: 'fire', name: 'Firebomb', cls: 'Explosive' } as unknown as WeaponDef;
/** the charge as a "combatant" for kill credit when it goes off */
const CHARGE_OWNER: Combatant = {
  id: -7, name: 'SPRENGLADNING', team: 2 as unknown as 0, isPlayer: false, health: 1, alive: true, kills: 0, deaths: 0, score: 0, assists: 0,
  position: () => new THREE.Vector3(), eye: (o = new THREE.Vector3()) => o, chest: (o = new THREE.Vector3()) => o, hitTest: () => null, onDamaged: () => {},
};

interface WorldGun { did: string; id: WeaponId; mesh: THREE.Object3D; pos: THREE.Vector3; vel: THREE.Vector3; rest: boolean; mag: number; reserve: number; t: number; by: Combatant | null }
interface FirePool { p: THREE.Vector3; r: number; t: number; life: number; owner: Combatant; key: string }

const inRect = (r: Rect, x: number, z: number, m = 0) => x >= r.x0 - m && x <= r.x1 + m && z >= r.z0 - m && z <= r.z1 + m;
/** the spawn (buy) zone of a side */
const BUYZONE = { T: AREA.tspawn, CT: { x0: -24, z0: -80, x1: 22, z1: -44 } as Rect };

export class SabMode {
  sab: Sabotage;
  ui: SabUI;
  brain: SabBrain;
  players: Combatant[] = [];
  private drops: WorldGun[] = [];
  private fires: FirePool[] = [];
  private chargeMesh: THREE.Group;
  private led: THREE.Mesh | null = null;
  private beepT = 0;
  private wireT = -1;
  private wirePick = -1;
  /** grenade slots selected for G / T */
  private sel: { lethal: Nade | null; tactical: Nade | null } = { lethal: null, tactical: null };
  private deadT = 0;
  private useHeld = false;
  /** the first-person plant / defuse animation in progress (driven from here) */
  private vmAct: { kind: 'plant' | 'defuse'; data: any } | null = null;
  private sentHold = false;
  private lastPhase = '';
  /** a soldier who joined mid-round sits out until the next one */
  private benched = new Set<number>();

  constructor(private g: G) {
    const self = this;
    const hooks: SabHooks = {
      roundStart: (atk) => self.roundStart(atk),
      goLive: () => self.goLive(),
      roundEnd: (e) => self.roundEnd(e),
      planted: (c, site, p) => self.planted(c, site, p),
      defused: (c, gamble) => self.defused(c, gamble),
      exploded: (p, by) => self.exploded(p, by),
      badWire: (c) => self.badWire(c),
      chargeMoved: (st, c) => self.chargeMoved(st, c),
      chargeSpawn: () => self.chargeSpawnPos(),
      swap: (k) => self.swap(k),
      matchEnd: (w) => self.matchEnd(w),
      callout: (k, c, n) => self.callout(k, c, n),
    };
    this.sab = new Sabotage(hooks);
    this.ui = new SabUI(g.ui.hudEl, g.ui.root);
    this.ui.weaponIcon = (n) => g.ui.weaponIcon?.(n) ?? null;
    this.ui.onBuy = (id) => this.playerBuy(id);
    this.ui.onSell = (id) => {
      if (this.sab.refund(g.avatar, id)) {
        this.applyKit(g.avatar, true);
        this.refreshBuy();
      }
    };
    this.ui.onRebuy = () => this.rebuy();
    this.ui.onCloseBuy = () => {
      if (g.state === 'playing') g.input.lock();
    };
    this.ui.onWire = (w) => this.wireKey(w);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.ui.buyOpen) this.ui.closeBuy();
    });
    this.brain = new SabBrain(g, this);
    this.chargeMesh = makeCharge();
    this.chargeMesh.visible = false;
    this.chargeMesh.scale.setScalar(1.25);
    this.chargeMesh.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    this.led = this.chargeMesh.getObjectByName('led') as THREE.Mesh | null;
    g.scene.add(this.chargeMesh);
  }

  // ================================================================ match setup
  /** pick the twelve in play (you + 5 bots v 6 bots; online: the humans first) and start */
  start() {
    const g = this.g;
    const me = g.avatar.team as 0 | 1;
    const pool = (t: 0 | 1) => (g.bots as Bot[]).filter((b) => b.team === t && !(NETF.active && b.netDisabled));
    const humansFirst = (l: Bot[]) => l.sort((a, b) => Number(b.netHuman) - Number(a.netHuman));
    const mates = humansFirst(pool(me)).slice(0, 5);
    const foes = humansFirst(pool((1 - me) as 0 | 1)).slice(0, 6);
    const inPlay = new Set<Bot>([...mates, ...foes]);
    for (const b of g.bots as Bot[]) {
      if (inPlay.has(b)) continue;
      if (!b.netDisabled) {
        b.netDisabled = true;
        b.netHide();
      }
    }
    this.players = [g.avatar, ...mates, ...foes];
    this.drops.forEach((d) => g.scene.remove(d.mesh));
    this.drops = [];
    this.ui.show(true);
    this.sab.start(this.players, Math.random() < 0.5 ? 0 : 1);
  }
  stop() {
    this.ui.show(false);
    this.clearWorld();
    this.chargeMesh.visible = false;
    this.g.audio.stopEmitter('sabBeep');
  }

  // ================================================================ hooks
  /** the charge's place at round start: open paving in the attackers' spawn, in front of the spawn
   *  line and clear of the station fountain */
  private chargeSpawnPos() {
    const p = new THREE.Vector3(6, 0, 56.5);
    p.y = this.groundY(p.setY(this.g.terrain.heightAt(p.x, p.z) + 0.5));
    return p;
  }
  private spawnFor(team: 0 | 1, i: number) {
    const tSide = team === this.sab.atk;
    const pts = SV_SPAWNS.filter((s) => s.team === (tSide ? 0 : 1));
    const s = pts[i % pts.length];
    const jx = (Math.random() - 0.5) * 1.2, jz = (Math.random() - 0.5) * 1.2;
    const x = s.x + jx, z = s.z + jz;
    return { pos: new THREE.Vector3(x, this.g.terrain.heightAt(x, z) + 0.15, z), yaw: s.yaw };
  }
  private clearWorld() {
    const g = this.g;
    g.explosives.clear();
    g.smoke?.clear();
    g.blastFx?.clear();
    g.deployables?.clear();
    g.destruction?.reset();
    g.world.buildings.glass.reset();
    for (const w of g.world.buildings.windows) w.broken = false;
    g.footprints?.clear();
    for (const d of this.drops) g.scene.remove(d.mesh);
    this.drops = [];
    for (const f of this.fires) g.audio.stopEmitter(f.key);
    this.fires = [];
  }
  private roundStart(atk: 0 | 1) {
    const g = this.g;
    this.clearWorld();
    this.benched.clear();
    const idx: [number, number] = [0, 0];
    for (const s of this.sab.seats) {
      const c = s.c;
      const team = c.team as 0 | 1;
      const sp = this.spawnFor(team, idx[team]++);
      if (c === g.avatar) {
        g.respawnPlayer();
        g.player.teleport(sp.pos, sp.yaw);
        g.spectating = false;
        g.vm.root.visible = true;
        this.deadT = 0;
      } else if (c instanceof Bot) {
        if (c.netPuppet) {
          // a remote human respawns on their own machine, where the host says
          this.net?.sabSendTo(c.id, { t: 'sabEv', k: 'spawn', p: sp.pos.toArray().map(r2), yaw: sp.yaw });
          continue;
        }
        c.spawn(sp.pos, sp.yaw);
      }
      c.health = 100;
      c.alive = true;
    }
    // bots spend their money (team plans: full buy / force / eco), then everyone gets their kit
    this.brain.buyRound();
    for (const s of this.sab.seats) this.applyKit(s.c, true);
    this.brain.newRound(atk);
    // the buy phase: everyone frozen in spawn
    g.player.frozen = true;
    for (const b of this.liveBots()) b.busy = true;
    this.sel = { lethal: null, tactical: null };
    this.pickNades();
    const side = this.sab.side(g.avatar.team);
    this.ui.say(side === 'atk' ? 'ANGREP' : 'FORSVAR', side === 'atk' ? `HENT LADNINGEN I SPAWN · PICK UP THE CHARGE, PLANT ON A OR B · RUNDE ${this.sab.round}` : `HOLD BOTH SITES · RUNDE ${this.sab.round}`, side, BUY_TIME - 1);
    this.openBuy();
    g.audio.play('uiReady', { bus: 'ui', gain: 0.45, reverb: 0 });
    g.audio.music.bedTo(null, 2);
    this.chargeMesh.visible = false;
    g.audio.stopEmitter('sabBeep');
    this.wireT = -1;
  }
  private goLive() {
    const g = this.g;
    g.player.frozen = false;
    for (const b of this.liveBots()) b.busy = false;
    g.audio.play('uiHorn', { bus: 'ui', gain: 0.45, reverb: 0 });
    g.radio.say('ann', this.sab.side(g.avatar.team) === 'atk' ? 'sabAttack' : 'sabDefend', g.time, { prio: 2, ttl: 3 });
    this.ui.say('KJØR!', 'GO GO GO', 'go', 1.4);
  }
  private roundEnd(e: RoundEnd) {
    const g = this.g;
    const me = g.avatar.team as 0 | 1;
    const won = e.winner === me;
    const mvpName = e.mvp ? (e.mvp === g.avatar ? 'DEG · YOU' : e.mvp.name.toUpperCase()) : '';
    const s = this.sab.seat(g.avatar);
    const nextHalf = this.sab.ot === 0 && this.sab.roundsPlayed === 6;
    const note = this.sab.winner !== -1 ? 'KAMPEN ER AVGJORT · MATCH OVER' : nextHalf ? 'PAUSE: SIDENE BYTTES · HALFTIME, SIDES SWAP' : this.sab.ot === 0 && this.sab.roundsPlayed === 12 ? 'OVERTID · OVERTIME' : '';
    this.ui.roundCard(e, me, this.sab.atk, e.money.get(g.avatar.id) ?? 0, mvpName, this.sab.score, note);
    g.audio.play(won ? 'flagWon' : 'flagLost', { bus: 'ui', gain: 0.7, reverb: 0 });
    g.audio.music.sting(won ? 'victory' : 'defeat');
    g.audio.music.bedTo(null, 3);
    g.audio.stopEmitter('sabBeep');
    if (e.mvp === g.avatar) g.audio.play('medal', { bus: 'ui', gain: 0.6, reverb: 0 });
    // the announcer
    const final = this.sab.score[e.winner] >= this.sab.target;
    const line = final ? (won ? 'win' : 'lose') : e.reason === 'defused' ? 'sabDefused' : e.reason === 'exploded' ? 'sabExploded' : won ? 'sabRoundWon' : 'sabRoundLost';
    g.radio.say('ann', line, g.time, { prio: 3, ttl: 4 });
    void s;
    this.ui.progress(null, 0, '');
    this.ui.wirePanel(null);
    this.ui.closeBuy();
  }
  private planted(c: Combatant, site: 'A' | 'B', p: THREE.Vector3) {
    const g = this.g;
    this.chargeMesh.visible = true;
    this.chargeMesh.position.copy(p).setY(this.groundY(p) + 0.02);
    // facing the way the planter knelt, lid and guard up, the LCD running
    this.chargeMesh.rotation.set(0, c instanceof Bot ? c.yaw : g.player.yaw, 0);
    // (the case lies a step in front of where the planter knelt)
    const fy = c instanceof Bot ? c.yaw : g.player.yaw;
    this.chargeMesh.position.x -= Math.sin(fy) * 0.45;
    this.chargeMesh.position.z -= Math.cos(fy) * 0.45;
    this.chargeMesh.position.y = this.groundY(this.chargeMesh.position) + 0.02;
    this.chargeState('armed');
    g.audio.play('place', { pos: p, gain: 0.8, ref: 4 });
    g.audio.play('armChirp', { pos: p, gain: 0.9, ref: 6 });
    const mine = c.team === g.avatar.team;
    this.ui.say(`LADNINGEN ER PLASSERT · ${site}`, mine ? 'FORSVAR LADNINGEN · DEFEND IT' : `DESARMER DEN · DEFUSE IT  (${FUSE} s)`, 'planted', 3);
    g.radio.say('ann', site === 'A' ? 'sabPlantedA' : 'sabPlantedB', g.time, { prio: 3, ttl: 4 });
    g.audio.music.bedTo('tension', 2);
    // the planter chooses the live wire: the player in the wire panel, bots at random
    if (c === g.avatar) {
      this.wireT = 2.6;
      this.wirePick = this.sab.charge.wire;
    }
    this.beepT = 0;
    this.brain.onPlanted(site, p);
  }
  private defused(c: Combatant, gamble: boolean) {
    const g = this.g;
    g.audio.play('claymoreClick', { pos: this.sab.charge.pos, gain: 1, ref: 5 });
    g.audio.play('beepLow', { pos: this.sab.charge.pos, gain: 0.8, ref: 5, rate: 0.7 });
    g.audio.stopEmitter('sabBeep');
    this.chargeState('defused', gamble ? this.sab.charge.wire : -1);
    this.ui.say(gamble ? 'RIKTIG LEDNING!' : 'DESARMERT', `${c === g.avatar ? 'DU' : c.name.toUpperCase()} ${gamble ? 'KUTTET RIKTIG · CUT THE RIGHT WIRE' : 'DESARMERTE LADNINGEN · DEFUSED THE CHARGE'}`, 'defused', 3);
  }
  private exploded(p: THREE.Vector3, by: Combatant | null) {
    const g = this.g;
    this.chargeMesh.visible = false;
    g.audio.stopEmitter('sabBeep');
    // a big one: everyone close dies, walls soak a lot of it
    CHARGE_OWNER.position = () => p.clone();
    g.explosives.explode(p.clone().setY(p.y + 0.4), CHARGE_OWNER, CHARGE_DEF, 26, 420);
    g.blastFx?.blast(p.clone().setY(p.y + 0.3), new THREE.Vector3(0, 1, 0), 3.2, 'concrete');
    const d = p.distanceTo(g.camera.position);
    g.rig.addTrauma(Math.max(0.15, 1.2 - d / 60));
    g.audio.play('explosion', { pos: p, gain: 1.6, ref: 18, reverb: 0.6, rate: 0.75 });
    g.audio.play('explosionFar', { pos: p, gain: 1.2, ref: 40, reverb: 0.8, rate: 0.8 });
    void by;
  }
  /** the world charge's look: shut (carried / dropped), armed (planted), defused */
  private chargeState(st: 'shut' | 'armed' | 'defused', cutWire = -1) {
    const m = this.chargeMesh;
    m.userData.reset?.();
    const led = this.led;
    if (led) {
      led.userData.red ??= (led.userData.base as THREE.Color).clone();
      led.userData.base = st === 'defused' ? new THREE.Color(0.4, 4.5, 0.8) : led.userData.red;
      setLed(led, st === 'defused' ? 1 : 0.05);
    }
    if (st === 'shut') return;
    m.getObjectByName('lid')!.rotation.z = 2.0;
    m.getObjectByName('armGuard')!.rotation.x = -1.95;
    const disp = m.userData.setDisplay as (s: string, mode: string) => void;
    if (st === 'defused') {
      disp('DESARMERT', 'defused');
      if (cutWire >= 0) (m.userData.cut as (i: number) => void)(cutWire);
      else for (let i = 0; i < 3; i++) {
        const cap = m.getObjectByName('cap' + i)!;
        cap.position.copy(cap.userData.rest as THREE.Vector3).add(new THREE.Vector3(0.012, 0.055, 0));
        cap.rotation.set(0, 0, -0.35);
      }
    } else disp(String(FUSE), 'armed');
  }
  private dispT = 0;
  private otherPlant = false;
  private capsOut = false;
  private badWire(c: Combatant) {
    const g = this.g;
    g.audio.play('claymoreClick', { pos: this.sab.charge.pos, gain: 1, ref: 5 });
    this.ui.say('FEIL LEDNING!', `${c === g.avatar ? 'DU' : c.name.toUpperCase()} KUTTET FEIL · WRONG WIRE`, 'boom', 3);
  }
  private chargeMoved(st: string, c: Combatant | null) {
    const g = this.g;
    if (st === 'dropped' && !c && this.sab.charge.fresh) {
      this.chargeState('shut');
      this.chargeMesh.rotation.set(0, Math.random() * Math.PI * 2, 0);
    }
    if (st === 'dropped' && this.sab.charge.state === 'dropped') {
      this.chargeMesh.visible = true;
      const p = this.sab.charge.pos;
      this.chargeMesh.position.copy(p).setY(this.groundY(p) + 0.02);
      if (c && c.team === g.avatar.team && this.sab.liveOrPlanted) {
        this.ui.say('LADNINGEN ER MISTET', 'THE CHARGE WAS DROPPED', 'warn', 2);
        g.radio.say('ann', 'sabDropped', g.time, { prio: 2, ttl: 3, cooldown: 8 });
      }
    } else if (st === 'carried') {
      this.chargeMesh.visible = false;
      this.chargeState('shut');
      if (c === g.avatar && this.sab.phase !== 'buy') g.ui.notify('DU HAR LADNINGEN', 'YOU HAVE THE CHARGE · [F] HOLD ON A SITE');
    }
  }
  private swap(kind: 'half' | 'ot') {
    this.g.radio.say('ann', kind === 'half' ? 'sabHalf' : 'sabOvertime', this.g.time, { prio: 3, ttl: 5 });
    this.ui.say(kind === 'half' ? 'PAUSE · SIDENE BYTTES' : 'OVERTID · SIDENE BYTTES', kind === 'half' ? 'HALFTIME · SWITCHING SIDES' : 'OVERTIME · SWITCHING SIDES', 'swap', 4);
    this.g.audio.play('uiHorn', { bus: 'ui', gain: 0.5, reverb: 0 });
  }
  private matchEnd(w: 0 | 1 | -1) {
    const g = this.g;
    if (g.state === 'ended') return;
    this.ui.closeBuy();
    g.match.phase = 'ended';
    g.match.winner = w;
    g.match.scores = [this.sab.score[0], this.sab.score[1]];
    const rows = this.sab.seats.map((s) => ({ name: s.c === g.avatar ? (localStorage.getItem('ff.name') || 'YOU') : s.c.name, team: s.c.team as 0 | 1, me: s.c === g.avatar, st: s.st, rounds: this.sab.roundsPlayed }));
    g.sabReport = this.ui.report(rows, g.avatar.team, this.sab.score, g.match.teamNames);
    g.match.onEnd(w);
  }
  private callout(kind: string, c: Combatant | null, n = 0) {
    const g = this.g;
    const who = c === g.avatar ? 'DU' : c?.name.toUpperCase() ?? '';
    if (kind === 'bounty' && c) {
      this.ui.say(`DUSØR PÅ ${who}`, `BOUNTY ${kr(n)} · ${c.team === g.avatar.team ? 'THEY WILL HUNT YOU' : 'WORTH HUNTING'}`, 'bounty', 2.8);
      if (c === g.avatar) g.radio.say('ann', 'sabBounty', g.time, { prio: 2, ttl: 4 });
      g.audio.play('streak', { bus: 'ui', gain: 0.4, reverb: 0 });
    } else if (kind === 'bountyPaid' && c) {
      if (c === g.avatar) g.ui.popup(`DUSØR · BOUNTY ${kr(n)}`, 0, 'kill');
      else this.ui.say(`${who} TOK DUSØREN`, `BOUNTY CLAIMED · ${kr(n)}`, 'bounty', 2);
    } else if (kind === 'clutch' && c) {
      if (c === g.avatar) {
        this.ui.say(`1 MOT ${n}`, 'CLUTCH · DU ER DEN SISTE · YOU ARE THE LAST ONE', 'clutch', 2.6);
        g.audio.play('heartbeat', { bus: 'ui', gain: 0.5, reverb: 0 });
      } else if (c.team === g.avatar.team) this.ui.say(`${who}: 1 MOT ${n}`, 'CLUTCH SITUATION', 'clutch', 2);
    } else if (kind === 'lastAlive' && c === g.avatar) {
      this.ui.say('SISTE MANN', 'LAST ONE STANDING', 'clutch', 2);
      g.radio.say('ann', 'sabLastAlive', g.time, { prio: 2, ttl: 3 });
    } else if (kind === 'matchPoint') {
      this.ui.say('KAMPBALL', 'MATCH POINT', 'mp', 2.4);
      g.later(1.2, () => g.radio.say('ann', 'sabMatchPoint', g.time, { prio: 2, ttl: 4 }));
    }
    else if (kind === 'lastRoundHalf') g.ui.notify('SISTE RUNDE FØR PAUSE', 'LAST ROUND OF THE HALF');
    else if (kind === 'tenSec') {
      g.audio.play('capTick', { bus: 'ui', gain: 0.5, reverb: 0 });
      g.radio.say('ann', 'sabTen', g.time, { prio: 2, ttl: 2 });
    }
  }

  // ================================================================ kits
  private liveBots() {
    return this.players.filter((c): c is Bot => c instanceof Bot && !c.netPuppet);
  }
  /** give a soldier their kit: guns, armour, grenades (bots carry one gun: their best) */
  applyKit(c: Combatant, refill: boolean) {
    const g = this.g;
    const s = this.sab.seat(c);
    if (!s) return;
    const k = s.kit;
    c.armor = k.armor;
    c.helmet = k.helmet;
    if (c === g.avatar) {
      const ids: WeaponId[] = k.primary ? [k.primary, k.secondary] : [k.secondary];
      const cur = g.weapons.slots.map((x: { def: WeaponDef }) => x.def.id).join();
      if (cur !== ids.join() || refill) g.weapons.setLoadout(ids);
      g.loadout.primary = ids[0];
      g.loadout.secondary = k.secondary;
      this.pickNades();
    } else if (c instanceof Bot && !c.netPuppet) {
      const id = k.primary ?? k.secondary;
      c.setWeapon(id, () => WEAPON_BUILDERS[id](g.wmats));
      // bots throw what they bought: HE / fire as their lethal, flash / smoke as their tactical
      (c as any).frags = k.nades.he + k.nades.fire;
      (c as any).tacticals = k.nades.flash + k.nades.smoke;
      if (k.nades.smoke && !k.nades.flash) (c as any).tacKind = 'smoke';
      else if (k.nades.flash) (c as any).tacKind = 'flash';
    }
  }
  /** keep the G / T slots on grenades you have (3 / 4 cycle them) */
  private pickNades() {
    const g = this.g;
    const k = this.sab.seat(g.avatar)?.kit;
    if (!k) return;
    const lethals: Nade[] = ['he', 'fire'], tacs: Nade[] = ['flash', 'smoke', 'decoy'];
    if (!this.sel.lethal || !k.nades[this.sel.lethal]) this.sel.lethal = lethals.find((n) => k.nades[n] > 0) ?? null;
    if (!this.sel.tactical || !k.nades[this.sel.tactical]) this.sel.tactical = tacs.find((n) => k.nades[n] > 0) ?? null;
    g.loadout.lethal = this.sel.lethal === 'fire' ? 'molotov' : 'frag';
    g.frags = this.sel.lethal ? k.nades[this.sel.lethal] : 0;
    g.loadout.tactical = this.sel.tactical ?? 'flash';
    g.tacCount = this.sel.tactical ? k.nades[this.sel.tactical] : 0;
  }
  private cycleNade(kind: 'lethal' | 'tactical') {
    const k = this.sab.seat(this.g.avatar)?.kit;
    if (!k) return;
    const list: Nade[] = kind === 'lethal' ? ['he', 'fire'] : ['flash', 'smoke', 'decoy'];
    const have = list.filter((n) => k.nades[n] > 0);
    if (have.length < 2) return;
    const i = have.indexOf(this.sel[kind] as Nade);
    this.sel[kind] = have[(i + 1) % have.length];
    this.pickNades();
    this.g.audio.play('cloth', { gain: 0.3, reverb: 0 });
  }
  /** after a throw the game's counters drop: mirror them into the kit */
  private syncNades() {
    const g = this.g;
    const k = this.sab.seat(g.avatar)?.kit;
    if (!k) return;
    if (this.sel.lethal && g.frags < k.nades[this.sel.lethal]) k.nades[this.sel.lethal] = Math.max(0, g.frags);
    if (this.sel.tactical && g.tacCount < k.nades[this.sel.tactical]) k.nades[this.sel.tactical] = Math.max(0, g.tacCount);
    if ((this.sel.lethal && !k.nades[this.sel.lethal]) || (this.sel.tactical && !k.nades[this.sel.tactical])) this.pickNades();
  }

  // ================================================================ buying
  inBuyZone(c: Combatant) {
    const p = c.position();
    const z = c.team === this.sab.atk ? BUYZONE.T : BUYZONE.CT;
    return inRect(z, p.x, p.z, 2);
  }
  private openBuy() {
    const g = this.g;
    const s = this.sab.seat(g.avatar);
    if (!s || !g.avatar.alive || g.state !== 'playing') return;
    this.ui.openBuy(s, this.sab, this.inBuyZone(g.avatar));
    if (g.input.locked) g.expectUnlock = true;
    g.input.unlock();
  }
  private refreshBuy() {
    const s = this.sab.seat(this.g.avatar);
    if (s) this.ui.refreshBuy(s, this.sab, this.inBuyZone(this.g.avatar));
  }
  private playerBuy(id: string) {
    const g = this.g;
    if (!this.sab.canBuy() || !this.inBuyZone(g.avatar) || !g.avatar.alive) return 'NO';
    const r = this.sab.buy(g.avatar, id);
    if (!r) {
      g.audio.play('uiConfirm', { bus: 'ui', gain: 0.45, reverb: 0 });
      g.audio.play('cloth', { gain: 0.35, reverb: 0 });
      const it = SHOP.find((x) => x.id === id);
      if (it?.weapon) this.applyKit(g.avatar, false);
      else {
        g.avatar.armor = this.sab.seat(g.avatar)!.kit.armor;
        g.avatar.helmet = this.sab.seat(g.avatar)!.kit.helmet;
        this.pickNades();
      }
      if (this.client) this.net?.sabSend({ t: 'sabIn', k: 'buy', id });
    } else g.audio.play('uiBack', { bus: 'ui', gain: 0.4, reverb: 0 });
    this.refreshBuy();
    return r;
  }
  private rebuy() {
    const s = this.sab.seat(this.g.avatar);
    if (!s) return;
    const prev = s.last.length ? [] : [...(this.prevBuys ?? [])];
    for (const id of prev) this.playerBuy(id);
    this.refreshBuy();
  }
  private prevBuys: string[] | null = null;

  // ================================================================ per frame
  update(dt: number) {
    const g = this.g;
    const sab = this.sab;
    if (sab.phase !== this.lastPhase) {
      if (this.lastPhase === 'post' || this.lastPhase === '') {
        const s = sab.seat(g.avatar);
        if (s && s.last.length) this.prevBuys = [...s.last];
        if (s) s.last = [];
      }
      this.lastPhase = sab.phase;
    }
    // the host / offline runs the rules; a client mirrors them
    if (!g.netg?.isClient) {
      sab.update(dt);
      if (this.net) this.remoteUse(dt);
    }
    this.ui.tick(dt);
    if (sab.phase === 'ended') return;
    this.playerInput(dt);
    if (!g.netg?.isClient) this.brain.update(dt);
    this.updateCharge(dt);
    this.updateDrops(dt);
    this.updateFires(dt);
    this.syncNades();
    this.hud(dt);
  }

  private playerInput(dt: number) {
    const g = this.g;
    const inp = g.input;
    const a = g.avatar;
    const sab = this.sab;
    // the buy menu: B in your spawn while buying is open
    if (inp.wasPressed('fireMode')) {
      if (this.ui.buyOpen) this.ui.closeBuy();
      else if (sab.canBuy() && a.alive && this.inBuyZone(a)) this.openBuy();
    }
    if (this.ui.buyOpen && (!sab.canBuy() || !this.inBuyZone(a) || !a.alive)) this.ui.closeBuy();
    // grenade slots
    if (inp.wasPressed('streak1')) this.cycleNade('lethal');
    if (inp.wasPressed('streak2')) this.cycleNade('tactical');
    if (!a.alive) {
      if (this.vmAct) this.vmAct.data.abort = true;
      this.deadT += dt;
      if (this.deadT > 2.4 && !g.spectating) this.spectateTeam();
      this.useHeld = false;
      return;
    }
    // the dropped charge: walk over it (attackers)
    if (sab.charge.state === 'dropped' && !this.client && sab.tryPickup(a)) g.audio.play('cloth', { gain: 0.6, reverb: 0 });
    // drop your gun for a teammate ([J])
    if (inp.wasPressed('drop')) this.playerDrop();
    // plant / defuse: hold F
    const holding = inp.isDown('spot') || !!(this.vmAct?.data.cut && !this.vmAct.data.snipped);
    const moving = g.player.horizSpeed() > 0.6;
    let r: 'plant' | 'defuse' | null;
    if (this.client) {
      const want = holding && !moving && this.usesF();
      if (want !== this.sentHold) {
        this.sentHold = want;
        this.net?.sabSend({ t: 'sabIn', k: 'use', h: want ? 1 : 0 });
      }
      r = want && sab.planting?.c === a ? 'plant' : want && sab.defusing?.c === a ? 'defuse' : want && (sab.charge.holder === a || sab.phase === 'planted') ? (sab.charge.holder === a ? 'plant' : 'defuse') : null;
    } else r = sab.use(a, holding, dt, moving);
    this.driveVm(r, dt);
    if (r) {
      // planting / defusing roots you (crouched, the gun lowered)
      g.player.frozen = true;
      g.player.forceCrouch?.(dt);
      g.weapons.enabled = false;
      if (!this.useHeld) g.playerVoice?.(r === 'plant' ? 'planting' : 'defusing', 0.9);
      this.useHeld = true;
      if (r === 'plant') this.ui.progress('plant', (sab.planting && sab.planting.c === a ? sab.planting.t : 0) / PLANT_TIME, 'PLASSERER · PLANTING');
      else {
        const d = sab.defusing ?? { t: 0, kit: !!sab.seat(a)?.kit.cutters, ruled: -1 };
        const need = d.kit ? DEFUSE_KIT : DEFUSE_TIME;
        this.ui.progress('defuse', d.t / need, d.t >= WIRE_OPEN ? 'DESARMERER · ELLER KUTT [1][2][3]' : 'DESARMERER · DEFUSING');
        if (d.t >= WIRE_OPEN) this.ui.wirePanel('cut', d.ruled);
        for (const [k, w] of [['primary', 0], ['secondary', 1], ['streak1', 2]] as const) if (inp.wasPressed(k)) this.wireKey(w);
      }
      if (Math.random() < dt * 3) g.audio.play('cloth', { gain: 0.25, rate: 1.3, reverb: 0 });
    } else if (this.useHeld) {
      this.useHeld = false;
      if (sab.phase !== 'buy') g.player.frozen = false;
      g.weapons.enabled = true;
      this.ui.progress(null, 0, '');
      if (this.wireT <= 0) this.ui.wirePanel(null);
    }
    // the planter's wire choice (a few seconds after the plant)
    if (this.wireT > 0) {
      this.wireT -= dt;
      this.ui.wirePanel('pick', -1, this.wirePick, this.wireT);
      for (const [k, w] of [['primary', 0], ['secondary', 1], ['streak1', 2]] as const) if (inp.wasPressed(k)) this.wireKey(w);
      if (this.wireT <= 0) this.ui.wirePanel(null);
    }
  }
  /** a wire key / click: the planter choosing, or a defuser cutting */
  private wireKey(w: number) {
    const g = this.g;
    if (this.wireT > 0) {
      this.wirePick = w;
      this.sab.setWire(w);
      if (this.client) this.net?.sabSend({ t: 'sabIn', k: 'wire', w });
      g.audio.play('click', { gain: 0.5, bus: 'ui', reverb: 0 });
      g.ui.notify(`LEVENDE LEDNING: ${WIRE_NAMES[w]}`, 'THE LIVE WIRE IS SET');
      this.wireT = Math.min(this.wireT, 0.6);
      return;
    }
    if (this.sab.defusing?.c === g.avatar && this.sab.defusing!.t >= WIRE_OPEN) {
      const doCut = () => {
        if (this.client) this.net?.sabSend({ t: 'sabIn', k: 'cut', w });
        else this.sab.cut(g.avatar, w);
      };
      // the cutters come out and the snip is the moment it is decided
      const act = this.vmAct;
      if (act?.kind === 'defuse' && !act.data.cut && !act.data.abort && g.vm.action?.data === act.data) {
        act.data.cut = { w };
        act.data.onSnip = doCut;
      } else if (!act?.data.cut) doCut();
    }
  }
  /** first-person plant / defuse: start, feed the real progress, finish or abort */
  private driveVm(r: 'plant' | 'defuse' | null, dt: number) {
    const g = this.g;
    const a = g.avatar;
    const sab = this.sab;
    let act = this.vmAct;
    if (act && g.vm.action?.data !== act.data) act = this.vmAct = null; // something else took the hands
    if (r && (!act || act.kind !== r || act.data.abort)) {
      if (g.weapons.reloading) g.weapons.cancelReload();
      const data: any = {
        p: 0,
        code: Array.from({ length: 7 }, () => Math.floor(Math.random() * 10)).join(''),
        timer: () => sab.timer,
        sfx: (n: string) => this.vmSfx(n),
      };
      data.drive = () => (data.finished ? 1 : Math.min(0.999, Math.max(0, data.p)));
      g.vm.play(r === 'plant' ? 'sabPlant' : 'sabDefuse', 1, [], () => {
        if (this.vmAct?.data === data) this.vmAct = null;
      }, data);
      act = this.vmAct = { kind: r, data };
    }
    if (!act) return;
    const d = act.data;
    if (act.kind === 'plant') {
      if (sab.planting?.c === a) d.p = sab.planting!.t / PLANT_TIME;
      if (sab.charge.state === 'planted' && sab.charge.planter === a) {
        d.p = 1;
        d.done = true;
      }
    } else {
      const df = sab.defusing;
      if (df?.c === a) d.p = df!.t / (df!.kit ? DEFUSE_KIT : DEFUSE_TIME);
      if (sab.charge.state === 'defused') d.done = true;
    }
    if (!r && !d.done && !(d.cut && !d.snipped)) d.abort = true;
    if (!a.alive) d.abort = true;
    // the view tips down onto the charge while defusing
    if (act.kind === 'defuse' && !d.abort && !d.done && g.player.pitch > -0.62) g.player.pitch += (-0.62 - g.player.pitch) * Math.min(1, dt * 3.5);
  }
  private vmSfx(n: string) {
    const au = this.g.audio;
    const o = { gain: 0.5, reverb: 0 };
    if (n === 'keyBeep') au.play('beep', { ...o, gain: 0.32, rate: 1.5 + Math.random() * 0.2 });
    else if (n === 'lidOpen') au.play('coverFlip', { ...o, rate: 0.8 });
    else if (n === 'guardFlip') au.play('coverFlip', { ...o, gain: 0.4, rate: 1.3 });
    else if (n === 'armChirp') au.play('armChirp', { ...o, gain: 0.6 });
    else if (n === 'placeDown') au.play('place', { ...o, gain: 0.7 });
    else if (n === 'capPull') au.play('pin', { ...o, gain: 0.45, rate: 0.85 + Math.random() * 0.15 });
    else if (n === 'snip') au.play('clack', { ...o, gain: 0.8, rate: 1.5 });
  }
  /** a local defuser sees the charge in their hands; the world copy hides meanwhile */
  private vmHidesCharge() {
    const act = this.vmAct;
    return !!act && act.kind === 'defuse' && !act.data.finished && !act.data.abort;
  }
  private spectateTeam() {
    const g = this.g;
    const mates = this.players.filter((c) => c.alive && c.team === g.avatar.team && c !== g.avatar);
    g.spectating = true;
    g.specFollow = (mates[0] ?? this.players.find((c) => c.alive && c !== g.avatar))?.id ?? -1;
    g.ui.showDeath(false);
  }

  // ================================================================ the charge in the world
  private groundY(p: THREE.Vector3) {
    const hit = this.g.physics.raycast(p.clone().setY(p.y + 1.2), new THREE.Vector3(0, -1, 0), 4);
    return hit ? hit.point.y : this.g.terrain.heightAt(p.x, p.z);
  }
  private updateCharge(dt: number) {
    const g = this.g;
    const ch = this.sab.charge;
    const pl = this.sab.planting, df = this.sab.defusing;
    // bots kneel over the charge while they plant / defuse (the pose code goes out to clients too)
    for (const c of this.players) {
      if (!(c instanceof Bot) || c.netPuppet) continue;
      c.busyAct = pl?.c === c ? 'sabPlant' : df?.c === c ? 'sabDefuse' : null;
      c.busyT = pl?.c === c ? Math.min(1, pl.t / PLANT_TIME) : df?.c === c ? Math.min(1, df.t / (df.kit ? DEFUSE_KIT : DEFUSE_TIME)) : 0;
    }
    // someone else planting: the case is on the ground in front of them, lid coming open, code going in
    if (pl && pl.c !== g.avatar && ch.state === 'carried') {
      const c = pl.c;
      const k = Math.min(1, pl.t / PLANT_TIME);
      const yaw = c instanceof Bot ? c.yaw : 0;
      const p = c.position();
      const m = this.chargeMesh;
      if (!this.otherPlant) {
        this.otherPlant = true;
        this.chargeState('shut');
      }
      m.visible = c instanceof Bot ? c.root.visible : true;
      m.position.set(p.x - Math.sin(yaw) * 0.45, 0, p.z - Math.cos(yaw) * 0.45);
      m.position.y = this.groundY(m.position) + 0.02;
      m.rotation.set(0, yaw, 0);
      m.getObjectByName('lid')!.rotation.z = 2 * Math.min(1, Math.max(0, (k - 0.03) / 0.17));
      m.getObjectByName('armGuard')!.rotation.x = k > 0.76 ? -1.95 : 0;
      const n = Math.max(0, Math.min(7, Math.floor((k - 0.22) / 0.48 * 7)));
      (m.userData.setDisplay as (s: string, mode: string) => void)(k > 0.83 ? 'ARMERT' : '*'.repeat(n).padEnd(7, '-'), k > 0.83 ? 'armed' : 'type');
      return;
    }
    if (this.otherPlant && !(pl && pl.c !== g.avatar)) {
      this.otherPlant = false;
      if (ch.state === 'carried') this.chargeMesh.visible = false;
    }
    // someone else defusing: the caps come out one by one
    if (df && ch.state === 'planted') {
      const k = Math.min(1, df.t / (df.kit ? DEFUSE_KIT : DEFUSE_TIME));
      const W = [0.33, 0.6, 0.86];
      for (let i = 0; i < 3; i++) {
        const cap = this.chargeMesh.getObjectByName('cap' + i)!;
        const u = Math.max(0, Math.min(1, (k - W[i] + 0.12) / 0.1));
        cap.position.copy(cap.userData.rest as THREE.Vector3).add(new THREE.Vector3(0.012 * u, 0.055 * u, 0));
        cap.rotation.z = -0.35 * u;
      }
      this.capsOut = true;
    } else if (this.capsOut && ch.state === 'planted') {
      this.capsOut = false;
      // a defuse given up: the caps go back in (as the rules reset the progress)
      for (let i = 0; i < 3; i++) {
        const cap = this.chargeMesh.getObjectByName('cap' + i)!;
        cap.position.copy(cap.userData.rest as THREE.Vector3);
        cap.rotation.z = 0;
      }
    }
    if (ch.state === 'planted') {
      // beeps speed up as the fuse runs down (real recorded beeps), the LED blinks with them
      const left = Math.max(0, this.sab.timer);
      const period = left > 20 ? 1.0 : left > 10 ? 0.6 : left > 5 ? 0.32 : left > 2 ? 0.17 : 0.09;
      this.beepT -= dt;
      if (this.beepT <= 0) {
        this.beepT = period;
        g.audio.play(left < 2 ? 'beepLow' : 'beep', { pos: ch.pos, gain: 0.7, ref: 5, reverb: 0.2, rate: left < 5 ? 1.15 : 1 });
        if (this.led) setLed(this.led, 1);
      } else if (this.led && this.beepT < period - 0.08) setLed(this.led, 0.05);
      this.chargeMesh.visible = !this.vmHidesCharge();
      // the LCD counts down (a few times a second is plenty for the world copy)
      this.dispT -= dt;
      if (this.dispT <= 0) {
        this.dispT = 0.1;
        const l = Math.max(0, left);
        (this.chargeMesh.userData.setDisplay as (s: string, m: string) => void)(l >= 10 ? String(Math.ceil(l)) : l.toFixed(1), 'armed');
      }
    } else if (ch.state === 'carried' && ch.holder && ch.holder !== g.avatar) {
      // on the carrier's back
      const h = ch.holder;
      const yaw = h instanceof Bot ? h.yaw : 0;
      const p = h.position();
      this.chargeMesh.visible = h instanceof Bot && h.root.visible;
      this.chargeMesh.position.set(p.x + Math.sin(yaw) * 0.2, p.y + 1.15, p.z + Math.cos(yaw) * 0.2);
      this.chargeMesh.rotation.set(Math.PI / 2, yaw, 0);
    } else if (ch.state === 'carried') this.chargeMesh.visible = false;
  }

  // ================================================================ guns on the ground
  /** a dead soldier's best gun falls where they died */
  private dropN = 0;
  dropGun(c: Combatant, id: WeaponId, from: THREE.Vector3, vel: THREE.Vector3, mag = -1, reserve = -1, did = `${c.id}:${this.sab.round}:${this.dropN++}`) {
    const g = this.g;
    if (this.drops.some((d) => d.did === did)) return;
    const model = WEAPON_BUILDERS[id](g.wmats);
    bakeFlat(model.root, 'botgun', 'botgun:' + id);
    const holder = new THREE.Group();
    holder.add(model.root);
    model.root.rotation.set(0, 0, Math.PI / 2);
    holder.position.copy(from);
    holder.rotation.y = Math.random() * Math.PI * 2;
    holder.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    g.scene.add(holder);
    const def = WEAPONS[id];
    this.drops.push({ did, id, mesh: holder, pos: from.clone(), vel: vel.clone(), rest: false, mag: mag < 0 ? def.mag : mag, reserve: reserve < 0 ? def.reserve : reserve, t: 0, by: c });
    if (this.drops.length > 24) g.scene.remove(this.drops.shift()!.mesh);
  }
  private playerDrop() {
    const g = this.g;
    const s = this.sab.seat(g.avatar);
    if (!s) return;
    // the charge first if you carry it, else your primary
    if (this.sab.charge.holder === g.avatar) {
      const f = new THREE.Vector3(-Math.sin(g.player.yaw), 0, -Math.cos(g.player.yaw));
      if (this.client) this.net?.sabSend({ t: 'sabIn', k: 'dropCharge' });
      else this.sab.dropCharge(g.avatar, g.player.pos.clone().addScaledVector(f, 1.6));
      return;
    }
    if (!s.kit.primary) return;
    const id = s.kit.primary;
    const slot = g.weapons.slots[0];
    const f = new THREE.Vector3(-Math.sin(g.player.yaw), 0.35, -Math.cos(g.player.yaw));
    const did = `${g.avatar.id}:${this.sab.round}:${this.dropN++}`;
    const at = g.camera.position.clone().addScaledVector(f, 0.6), vel = f.clone().multiplyScalar(4.5);
    this.dropGun(g.avatar, id, at, vel, slot?.mag ?? -1, slot?.reserve ?? -1, did);
    s.kit.primary = null;
    this.applyKit(g.avatar, false);
    g.audio.play('cloth', { gain: 0.5, reverb: 0 });
    this.sendDrop(did, id, at, vel, slot?.mag ?? -1, slot?.reserve ?? -1);
  }
  private updateDrops(dt: number) {
    const g = this.g;
    const a = g.avatar;
    const me = this.sab.seat(a);
    let focus: WorldGun | null = null;
    for (const d of this.drops) {
      d.t += dt;
      if (!d.rest) {
        d.vel.y -= 9.8 * dt;
        const step = d.vel.clone().multiplyScalar(dt);
        const hit = g.physics.raycast(d.pos, step.clone().normalize(), step.length() + 0.08);
        if (hit) {
          d.pos.copy(hit.point).setY(hit.point.y + 0.06);
          if (hit.normal.y > 0.6) {
            d.rest = true;
            d.vel.set(0, 0, 0);
            g.audio.play('bounce_metal', { pos: d.pos, gain: 0.5, ref: 3, rate: 0.8 });
          } else d.vel.reflect(hit.normal).multiplyScalar(0.3);
        } else d.pos.add(step);
        d.mesh.position.copy(d.pos);
      }
      // walking over a gun picks it up if that slot is empty
      if (!a.alive || !me || d.t < 0.8) continue;
      const dd = Math.hypot(d.pos.x - a.position().x, d.pos.z - a.position().z);
      if (dd > 2.2 || Math.abs(d.pos.y - a.position().y) > 2) continue;
      const prim = WEAPONS[d.id].slot === 'primary';
      if (dd < 1.0 && ((prim && !me.kit.primary) || (!prim && me.kit.secondary === 'p80' && d.id !== 'p80'))) {
        this.take(d);
        return;
      }
      if (!focus || dd < Math.hypot(focus.pos.x - a.position().x, focus.pos.z - a.position().z)) focus = d;
    }
    // F near a gun swaps it for yours
    if (focus && me) {
      g.ui.interactHint(`[F] BYTT TIL · SWAP TO ${WEAPONS[focus.id].short}`);
      if (g.input.wasPressed('spot') && !this.sab.planting && !this.sab.defusing) this.take(focus);
    }
  }
  private take(d: WorldGun) {
    const g = this.g;
    const me = this.sab.seat(g.avatar)!;
    const prim = WEAPONS[d.id].slot === 'primary';
    const old = prim ? me.kit.primary : me.kit.secondary;
    if (old && (prim || old !== 'p80')) {
      const f = new THREE.Vector3(-Math.sin(g.player.yaw), 0.3, -Math.cos(g.player.yaw));
      const slot = g.weapons.slots[prim ? 0 : g.weapons.slots.length - 1];
      const did = `${g.avatar.id}:${this.sab.round}:${this.dropN++}`;
      const at = g.camera.position.clone().addScaledVector(f, 0.5), vel = f.clone().multiplyScalar(3);
      this.dropGun(g.avatar, old, at, vel, slot?.mag ?? -1, slot?.reserve ?? -1, did);
      this.sendDrop(did, old, at, vel, slot?.mag ?? -1, slot?.reserve ?? -1);
    }
    if (prim) me.kit.primary = d.id;
    else me.kit.secondary = d.id;
    g.scene.remove(d.mesh);
    this.drops = this.drops.filter((x) => x !== d);
    this.applyKit(g.avatar, false);
    // the gun keeps the ammo it had
    const slot = g.weapons.slots[prim ? 0 : g.weapons.slots.length - 1];
    if (slot && slot.def.id === d.id) {
      slot.mag = d.mag;
      slot.reserve = d.reserve;
    }
    g.audio.play('cloth', { gain: 0.6, reverb: 0 });
    g.audio.play(g.audio.has(`magIn@${d.id}`) ? `magIn@${d.id}` : 'click', { gain: 0.4, reverb: 0 });
    this.sendTake(d.did, g.avatar.id, d.id);
  }
  /** a bot walks over a better gun (the brain asks) */
  botTake(b: Bot, d: WorldGun) {
    const s = this.sab.seat(b);
    if (!s) return;
    const prim = WEAPONS[d.id].slot === 'primary';
    if (prim) s.kit.primary = d.id;
    else s.kit.secondary = d.id;
    this.g.scene.remove(d.mesh);
    this.drops = this.drops.filter((x) => x !== d);
    this.applyKit(b, false);
    this.sendTake(d.did, b.id, d.id);
  }
  groundGuns() {
    return this.drops;
  }


  // ================================================================ online (Update 42)
  // The host runs the rules and the bots; its snapshots carry the round state (netState) at
  // 10 Hz. Clients send what their player does (hold F, buy, cut a wire, drop, take) and get
  // spawns and gun pickups as events. Every machine simulates the guns on the ground itself.
  private get net() {
    return this.g.netg?.active ? this.g.netg : null;
  }
  private get client() {
    return !!this.g.netg?.isClient;
  }
  private byId(id: number): Combatant | null {
    if (id === this.g.avatar.id) return this.g.avatar;
    return (this.g.bots as Bot[]).find((b) => b.id === id) ?? null;
  }
  private sendDrop(did: string, id: WeaponId, at: THREE.Vector3, vel: THREE.Vector3, mag: number, res: number) {
    const n = this.net;
    if (!n) return;
    const m = { t: 'sabEv', k: 'drop', did, id, p: at.toArray().map(r2), v: vel.toArray().map(r2), mag, res, by: this.g.avatar.id };
    if (this.client) n.sabSend({ ...m, t: 'sabIn' });
    else n.sabBroadcast(m);
  }
  private sendTake(did: string, by: number, id: WeaponId) {
    const n = this.net;
    if (!n) return;
    if (this.client) n.sabSend({ t: 'sabIn', k: 'take', did, id });
    else n.sabBroadcast({ t: 'sabEv', k: 'took', did, by, id });
  }
  /** host: the round state for the snapshot */
  netState() {
    const s = this.sab;
    const ch = s.charge;
    return {
      ids: this.players.map((c) => c.id), ph: s.phase, tm: r2(s.timer), rd: s.round, sc: s.score, atk: s.atk, ot: s.ot, lt: r2(s.liveT), w: s.winner,
      ch: [ch.state, ch.holder?.id ?? -1, r2(ch.pos.x), r2(ch.pos.y), r2(ch.pos.z), ch.site ?? '', ch.planter?.id ?? -1],
      pl: s.planting ? [s.planting.c.id, r2(s.planting.t)] : null,
      df: s.defusing ? [s.defusing.c.id, r2(s.defusing.t), s.defusing.kit ? 1 : 0, s.defusing.ruled] : null,
      st: s.seats.map((x) => [x.c.id, x.money, x.kit.primary ?? '', x.kit.secondary, Math.round(x.kit.armor), x.kit.helmet ? 1 : 0, x.kit.cutters ? 1 : 0, ...NADES.map((n) => x.kit.nades[n]),
        x.st.kills, x.st.deaths, x.st.assists, Math.round(x.st.dmg), x.st.openings, x.st.clutches, x.st.mvps, x.st.hotRounds]),
      last: s.last ? [s.last.winner, s.last.reason, s.last.mvp?.id ?? -1, s.last.mvpWhy, s.last.clutch ? s.last.clutch.c.id : -1, s.last.clutch?.vs ?? 0, s.last.round, [...s.last.money.entries()]] : null,
    };
  }
  /** client: mirror the host's round state and play the local side of what changed */
  private gotState = false;
  applyNet(m: any) {
    const g = this.g;
    const s = this.sab;
    if (!this.gotState) {
      this.gotState = true;
      // joined in the buy phase: the host places us; mid-round: sit it out
      if (m.ph === 'buy') this.net?.sabSend({ t: 'sabIn', k: 'spawnMe' });
      else g.later(0.1, () => this.joinedMidRound());
    }
    const ids: number[] = m.ids;
    // the twelve in play
    const list = ids.map((id) => this.byId(id)).filter((c): c is Combatant => !!c);
    if (list.map((c) => c.id).join() !== this.players.map((c) => c.id).join()) this.players = list;
    for (const c of list) if (!s.seat(c)) s.addSeat(c);
    s.seats = s.seats.filter((x) => list.includes(x.c));
    const prev = { ph: s.phase, rd: s.round, ch: s.charge.state, last: s.last?.round ?? -1 };
    s.phase = m.ph;
    s.timer = m.tm;
    s.round = m.rd;
    s.score = m.sc;
    s.atk = m.atk;
    s.ot = m.ot;
    s.liveT = m.lt;
    s.winner = m.w;
    const [cs, hid, cx, cy, cz, site, pid] = m.ch;
    s.charge.state = cs;
    s.charge.holder = hid >= 0 ? this.byId(hid) : null;
    s.charge.pos.set(cx, cy, cz);
    s.charge.site = site || null;
    s.charge.planter = pid >= 0 ? this.byId(pid) : null;
    s.planting = m.pl ? { c: this.byId(m.pl[0])!, t: m.pl[1] } : null;
    s.defusing = m.df ? { c: this.byId(m.df[0])!, t: m.df[1], kit: !!m.df[2], ruled: m.df[3] } : null;
    for (const r of m.st) {
      const c = this.byId(r[0]);
      const seat = c && s.seat(c);
      if (!seat) continue;
      seat.money = r[1];
      const k = seat.kit;
      const kitKey = `${r[2]}|${r[3]}`;
      k.primary = r[2] || null;
      k.secondary = r[3];
      k.armor = r[4];
      k.helmet = !!r[5];
      k.cutters = !!r[6];
      NADES.forEach((n, i) => (k.nades[n] = r[7 + i]));
      const o = 7 + NADES.length;
      [seat.st.kills, seat.st.deaths, seat.st.assists, seat.st.dmg, seat.st.openings, seat.st.clutches, seat.st.mvps, seat.st.hotRounds] = r.slice(o, o + 8);
      // puppets carry the gun they bought (visual); my own kit is applied when it changes
      if (c instanceof Bot) {
        const id = k.primary ?? k.secondary;
        if (c.def.id !== id) c.setWeapon(id, () => WEAPON_BUILDERS[id](g.wmats));
      } else if (c === g.avatar && kitKey !== this.myKitKey) {
        this.myKitKey = kitKey;
        this.applyKit(g.avatar, false);
      }
    }
    // local reactions
    if (s.round !== prev.rd || (s.phase === 'buy' && prev.ph !== 'buy')) this.clientRoundStart();
    if (s.phase === 'live' && prev.ph === 'buy') this.goLive();
    if (s.charge.state === 'planted' && prev.ch !== 'planted') this.planted(s.charge.planter ?? g.avatar, (s.charge.site ?? 'A') as 'A' | 'B', s.charge.pos.clone());
    // the charge lying loose (the round-start spawn drop, a dead carrier) / picked up
    if (s.charge.state === 'dropped' && (prev.ch !== 'dropped' || this.chargeMesh.position.distanceToSquared(s.charge.pos) > 0.25 || !this.chargeMesh.visible)) {
      if (prev.ch !== 'dropped') this.chargeState('shut');
      this.chargeMoved('dropped', null);
    }
    if (s.charge.state === 'carried' && prev.ch !== 'carried') this.chargeMoved('carried', s.charge.holder);
    if (s.charge.state === 'exploded' && prev.ch !== 'exploded') this.exploded(s.charge.pos.clone(), s.charge.planter);
    if (s.charge.state === 'defused' && prev.ch !== 'defused' && s.last) this.defused(s.last.mvp ?? g.avatar, false);
    if (m.last && m.last[6] !== prev.last && s.phase === 'post') {
      const [w, reason, mvp, why, cl, vs, round, money] = m.last;
      s.last = { winner: w, reason, mvp: mvp >= 0 ? this.byId(mvp) : null, mvpWhy: why, clutch: cl >= 0 ? { c: this.byId(cl)!, vs } : null, money: new Map(money), round };
      this.roundEnd(s.last);
    }
    if (s.phase === 'ended' && prev.ph !== 'ended' && s.winner !== -1) this.matchEnd(s.winner as 0 | 1);
  }
  private myKitKey = '';
  private clientRoundStart() {
    const g = this.g;
    this.clearWorld();
    this.chargeMesh.visible = false;
    g.audio.stopEmitter('sabBeep');
    this.ui.progress(null, 0, '');
    this.ui.wirePanel(null);
    this.wireT = -1;
    this.sel = { lethal: null, tactical: null };
    const side = this.sab.side(g.avatar.team);
    this.ui.say(side === 'atk' ? 'ANGREP' : 'FORSVAR', `RUNDE ${this.sab.round}`, side, BUY_TIME - 1);
    g.audio.play('uiReady', { bus: 'ui', gain: 0.45, reverb: 0 });
  }
  /** host: what a remote player is doing / asking for */
  private held = new Map<number, boolean>();
  netInput(slot: number, m: any) {
    const g = this.g;
    const c = this.byId(slot);
    if (!c) return;
    const s = this.sab;
    switch (m.k) {
      case 'use':
        this.held.set(slot, !!m.h);
        break;
      case 'spawnMe': {
        if (s.phase !== 'buy') break;
        const seat = s.seat(c);
        if (seat) seat.money = Math.max(seat.money, s.ot ? 10000 : 800);
        const i = this.players.filter((x) => x.team === c.team).indexOf(c);
        const sp = this.spawnFor(c.team as 0 | 1, Math.max(0, i));
        g.netg?.sabSendTo(slot, { t: 'sabEv', k: 'spawn', p: sp.pos.toArray().map(r2), yaw: sp.yaw });
        break;
      }
      case 'buy':
        if (s.canBuy() && this.inBuyZone(c)) s.buy(c, String(m.id));
        break;
      case 'wire':
        if (s.charge.planter === c && s.phase === 'planted') s.setWire(m.w);
        break;
      case 'cut':
        s.cut(c, m.w);
        break;
      case 'dropCharge':
        s.dropCharge(c);
        break;
      case 'drop': {
        const seat = s.seat(c);
        if (seat && seat.kit.primary === m.id) seat.kit.primary = null;
        this.dropGun(c, m.id, new THREE.Vector3(...m.p), new THREE.Vector3(...m.v), m.mag, m.res, m.did);
        g.netg?.sabBroadcast({ ...m, t: 'sabEv', k: 'drop', by: slot });
        break;
      }
      case 'take': {
        const d = this.drops.find((x) => x.did === m.did);
        const seat = s.seat(c);
        if (!d || !seat) {
          // too late: someone else has it — give the player back what the host thinks they carry
          return;
        }
        if (WEAPONS[d.id].slot === 'primary') seat.kit.primary = d.id;
        else seat.kit.secondary = d.id;
        g.scene.remove(d.mesh);
        this.drops = this.drops.filter((x) => x !== d);
        g.netg?.sabBroadcast({ t: 'sabEv', k: 'took', did: m.did, by: slot, id: d.id });
        break;
      }
    }
  }
  /** host: run hold-to-use and charge pickups for remote players (every frame) */
  private remoteUse(dt: number) {
    for (const c of this.players) {
      if (!(c instanceof Bot) || !c.netPuppet || !c.alive) continue;
      const p = c.position();
      const last = (c as any)._sabLast as THREE.Vector3 | undefined;
      const moving = !!last && Math.hypot(p.x - last.x, p.z - last.z) / Math.max(dt, 1e-3) > 0.9;
      (c as any)._sabLast = p.clone();
      this.sab.use(c, !!this.held.get(c.id), dt, moving);
      if (this.sab.charge.state === 'dropped') this.sab.tryPickup(c);
    }
  }
  /** every machine: an event from the host (or relayed) */
  netEvent(m: any) {
    const g = this.g;
    switch (m.k) {
      case 'spawn': {
        g.respawnPlayer();
        g.player.teleport(new THREE.Vector3(m.p[0], m.p[1], m.p[2]), m.yaw);
        g.spectating = false;
        g.vm.root.visible = true;
        g.player.frozen = this.sab.phase === 'buy';
        this.deadT = 0;
        this.applyKit(g.avatar, true);
        if (this.sab.phase === 'buy') this.openBuy();
        break;
      }
      case 'drop':
        if (m.by !== g.avatar.id) this.dropGun(this.byId(m.by) ?? g.avatar, m.id, new THREE.Vector3(...m.p), new THREE.Vector3(...m.v), m.mag, m.res, m.did);
        break;
      case 'took': {
        const d = this.drops.find((x) => x.did === m.did);
        if (d) {
          g.scene.remove(d.mesh);
          this.drops = this.drops.filter((x) => x !== d);
        }
        break;
      }
    }
  }
  /** a client joined while a round is on: they sit it out and watch their team */
  joinedMidRound() {
    const g = this.g;
    if (this.sab.phase === 'buy') return;
    g.avatar.alive = false;
    g.avatar.health = 0;
    g.player.dead = true;
    g.weapons.enabled = false;
    this.deadT = 3;
    this.ui.say('DU ER MED FRA NESTE RUNDE', 'YOU JOIN FROM THE NEXT ROUND', '', 3);
  }
  /** host: the soldiers in play changed (players joined / left, the bot count) */
  resync() {
    const g = this.g;
    const me = g.avatar.team as 0 | 1;
    const inPlay = (g.bots as Bot[]).filter((b) => !b.netDisabled);
    const mates = inPlay.filter((b) => b.team === me).slice(0, 5);
    const foes = inPlay.filter((b) => b.team !== me).slice(0, 6);
    const list: Combatant[] = [g.avatar, ...mates, ...foes];
    for (const b of inPlay) if (!list.includes(b)) {
      b.netDisabled = true;
      b.netHide();
    }
    for (const c of list) if (!this.sab.seat(c)) this.sab.addSeat(c);
    this.sab.seats = this.sab.seats.filter((x) => list.includes(x.c));
    this.players = list;
  }

  // ================================================================ firebombs
  fire(p: THREE.Vector3, owner: Combatant) {
    const g = this.g;
    const key = 'sabFire' + Math.floor(Math.random() * 1e6);
    this.fires.push({ p: p.clone(), r: 0, t: 0, life: 7, owner, key });
    g.audio.play(g.audio.has('glassShatter') ? 'glassShatter' : 'imp_glass', { pos: p, gain: 0.7, ref: 4 });
    g.audio.play('fireIgnite', { pos: p, gain: 1.0, ref: 6 });
  }
  private updateFires(dt: number) {
    const g = this.g;
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.t += dt;
      f.r = 3.4 * Math.min(1, f.t / 0.6);
      // smoke puts it out
      const doused = g.explosives.smokes.some((c: { p: THREE.Vector3; r: number }) => c.r > 1 && c.p.distanceTo(f.p) < c.r + f.r * 0.6);
      if (doused && f.t > 0.2) f.life = Math.min(f.life, f.t + 0.4);
      if (f.t >= f.life) {
        g.audio.stopEmitter(f.key);
        this.fires.splice(i, 1);
        g.audio.play('smokeHiss', { pos: f.p, gain: 0.5, ref: 4 });
        continue;
      }
      const fade = Math.min(1, (f.life - f.t) / 1.2);
      // flames: bright sparks rising, dark smoke above
      if (f.p.distanceTo(g.camera.position) < 120) {
        const n = Math.ceil(5 * fade);
        for (let k = 0; k < n; k++) {
          const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * f.r;
          const pp = new THREE.Vector3(f.p.x + Math.cos(a) * r, f.p.y + 0.05, f.p.z + Math.sin(a) * r);
          g.fx.sparks.spawn(pp, new THREE.Vector3((Math.random() - 0.5) * 0.5, 1.4 + Math.random() * 1.6, (Math.random() - 0.5) * 0.5), [4.6, 1.6 + Math.random() * 0.6, 0.35], 1, 0.28 + Math.random() * 0.25, 0.35 + Math.random() * 0.2, { drag: 1, grav: -2.2, grow: 1.6 });
        }
        if (Math.random() < 0.5) g.fx.smoke.spawn(f.p.clone().add(new THREE.Vector3((Math.random() - 0.5) * f.r, 1.2, (Math.random() - 0.5) * f.r)), new THREE.Vector3(0, 1.6, 0), [0.08, 0.075, 0.07], 0.55, 0.9, 4, { drag: 0.3, grav: -0.3, grow: 1.5 });
      }
      g.audio.emitter(f.key, 'carFire', 0.8 * fade, f.p, { ref: 5, bus: 'sfx' });
      // burning: enemies and the thrower (teammates are safe, like every grenade here)
      g.burnAt(f.p, f.r, 38, f.owner, dt, (c: Combatant) => c.team !== f.owner.team || c === f.owner, 1.6, 'Firebomb');
    }
  }
  /** F belongs to the mode right now (plant / defuse / a gun at your feet), not to doors / spotting */
  /**
   * Where the charge shows on the radar / the map for this player: planted — everyone; dropped
   * or carried — the attackers only (who has it is their business).
   */
  chargeView(): { x: number; z: number; state: 'dropped' | 'carried' | 'planted'; who?: string; timer?: number } | null {
    const g = this.g;
    const s = this.sab;
    const ch = s.charge;
    if (s.phase === 'ended') return null;
    const atk = g.avatar.team === s.atk;
    if (ch.state === 'planted') return { x: ch.pos.x, z: ch.pos.z, state: 'planted', timer: s.timer };
    if (!atk) return null;
    if (ch.state === 'dropped') return { x: ch.pos.x, z: ch.pos.z, state: 'dropped' };
    if (ch.state === 'carried' && ch.holder) {
      const p = ch.holder.position();
      return { x: p.x, z: p.z, state: 'carried', who: ch.holder === g.avatar ? 'DEG' : ch.holder.name };
    }
    return null;
  }
  usesF() {
    const g = this.g;
    const a = g.avatar;
    const sab = this.sab;
    if (!a.alive) return false;
    if (sab.charge.holder === a && sab.phase === 'live' && sab.siteAt(g.player.pos)) return true;
    if (sab.phase === 'planted' && a.team !== sab.atk && g.player.pos.distanceTo(sab.charge.pos) < 2.2) return true;
    return this.drops.some((d) => d.t > 0.8 && Math.hypot(d.pos.x - g.player.pos.x, d.pos.z - g.player.pos.z) < 2.2);
  }
  inFire(p: THREE.Vector3) {
    return this.fires.some((f) => Math.hypot(p.x - f.p.x, p.z - f.p.z) < f.r + 0.8 && Math.abs(p.y - f.p.y) < 2);
  }
  fireSpots() {
    return this.fires;
  }

  // ================================================================ kills, damage (from the game)
  onKill(killer: Combatant, victim: Combatant, weapon: string) {
    const g = this.g;
    const def = Object.values(WEAPONS).find((w) => w.name === weapon) ?? null;
    this.sab.onKill(killer, victim, def, weapon);
    // what they carried falls out
    const s = this.sab.seat(victim);
    if (s) {
      const p = victim.position().clone().setY(victim.position().y + 1.0);
      const v = new THREE.Vector3((Math.random() - 0.5) * 2, 1.5, (Math.random() - 0.5) * 2);
      if (s.kit.primary) this.dropGun(victim, s.kit.primary, p, v);
      else if (s.kit.secondary !== 'p80') this.dropGun(victim, s.kit.secondary, p, v);
      s.kit = defaultKit();
    }
    if (victim === g.avatar) {
      this.deadT = 0;
      this.ui.closeBuy();
      this.ui.progress(null, 0, '');
      this.ui.wirePanel(null);
      g.weapons.enabled = false;
    }
    this.brain.onKill(killer, victim);
  }
  onDamage(victim: Combatant, attacker: Combatant | null, amount: number) {
    this.sab.onDamage(victim, attacker, amount, victim.health + amount);
  }

  // ================================================================ HUD
  private hud(dt: number) {
    const g = this.g;
    const sab = this.sab;
    const me = g.avatar.team as 0 | 1;
    const seat = sab.seat(g.avatar);
    const portraits: Portrait[] = this.players.map((c) => {
      const st = sab.seat(c);
      return {
        id: c.id, team: c.team as 0 | 1, name: c === g.avatar ? 'DEG' : c.name, alive: c.alive, hp: c.health, me: c === g.avatar,
        charge: sab.charge.holder === c && c.team === me, bounty: st ? bountyFor(st.st.hotRounds) : 0, weapon: st?.kit.primary ?? st?.kit.secondary ?? 'p80',
      };
    });
    this.ui.topBar(sab, me, g.match.teamNames, portraits);
    if (seat) {
      const buyable = sab.canBuy() && this.inBuyZone(g.avatar) && g.avatar.alive;
      const hint = sab.phase === 'buy' ? '' : buyable ? `${Math.ceil(18 - sab.liveT)} s` : '';
      this.ui.wallet(seat.money, buyable, sab.side(me), hint);
      this.ui.kitBar(seat.kit, this.sel, g.avatar.armor ?? 0, sab.charge.holder === g.avatar);
    }
    // the prompts
    if (g.avatar.alive && !this.useHeld) {
      if (sab.charge.holder === g.avatar && sab.phase === 'live' && sab.siteAt(g.player.pos)) g.ui.interactHint('[F] HOLD: PLASSER LADNINGEN · PLANT THE CHARGE');
      else if (sab.phase === 'planted' && g.avatar.team !== sab.atk && g.player.pos.distanceTo(sab.charge.pos) < 1.9) g.ui.interactHint('[F] HOLD: DESARMER · DEFUSE');
    }
    // spectating
    if (!g.avatar.alive && g.spectating) {
      const t = this.players.find((c) => c.id === g.specFollow);
      this.ui.spectating(t ? t.name.toUpperCase() : null, '[LMB] NESTE · NEXT');
    } else this.ui.spectating(null);
    // world markers: the charge (planted for everyone, dropped for attackers), the site letters
    const cam = g.camera;
    const W = window.innerWidth, H = window.innerHeight;
    const marks: { x: number; y: number; label: string; cls: string; ico?: string; dist?: number }[] = [];
    const proj = (p: THREE.Vector3) => {
      const v = p.clone().project(cam);
      if (v.z > 1) return null;
      return { x: Math.max(30, Math.min(W - 30, (v.x * 0.5 + 0.5) * W)), y: Math.max(60, Math.min(H - 60, (-v.y * 0.5 + 0.5) * H)) };
    };
    const ch = sab.charge;
    if (ch.state === 'planted' || (ch.state === 'dropped' && me === sab.atk)) {
      const s = proj(ch.pos.clone().setY(ch.pos.y + 0.6));
      if (s) marks.push({ ...s, label: ch.state === 'planted' ? `${Math.ceil(Math.max(0, sab.timer))}` : 'LADNING', cls: ch.state === 'planted' ? 'planted' : 'dropped', ico: 'charge', dist: ch.pos.distanceTo(cam.position) });
    }
    // the carrier, for their own side: the charge icon over their head
    if (ch.state === 'carried' && ch.holder && ch.holder !== g.avatar && ch.holder.team === me && ch.holder.alive) {
      const hp = ch.holder.position();
      const s = proj(hp.clone().setY(hp.y + 2.25));
      if (s) marks.push({ ...s, label: ch.holder.name.toUpperCase(), cls: 'carrier', ico: 'charge', dist: hp.distanceTo(cam.position) });
    }
    if (sab.phase === 'buy' || (sab.phase === 'live' && sab.liveT < 20)) {
      for (const st of SV_SITES) {
        const s = proj(new THREE.Vector3(st.x, g.terrain.heightAt(st.x, st.z) + 2.5, st.z));
        if (s) marks.push({ ...s, label: st.letter, cls: 'site', dist: Math.hypot(st.x - cam.position.x, st.z - cam.position.z) });
      }
    }
    this.ui.markers(marks);
    void dt;
  }
}

const r2 = (v: number) => Math.round(v * 100) / 100;
export type { Kit, Seat };
export { NADES };
