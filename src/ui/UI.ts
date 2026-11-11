import { Settings, SettingsData, Quality } from '../game/Settings';
import { ACTION_LABELS, keysFor, keyLabel, applyKeybinds, Action } from '../core/Input';
import { loadIce, saveIce, testIce } from '../net/Net';
import { WEAPONS, PRIMARIES, SECONDARIES, WeaponDef } from '../weapons/WeaponDefs';
import type { WeaponPreview } from './WeaponPreview';
import { icon } from './Icons';
import { WeaponId } from '../weapons/WeaponModels';
import { KillEvent } from '../game/Match';
import { CombatantState } from '../game/Combatant';

/** Per-frame HUD writes: skip identical values (each textContent write allocates a new text node and dirties layout). */
const setText = (el: Element | null | undefined, v: string) => {
  if (el && (el as any)._tv !== v) {
    (el as any)._tv = v;
    el.textContent = v;
  }
};
const setHTML = (el: Element | null | undefined, v: string) => {
  if (el && (el as any)._hv !== v) {
    (el as any)._hv = v;
    el.innerHTML = v;
  }
};
const setCls = (el: Element, v: string) => {
  if ((el as any)._cv !== v) {
    (el as any)._cv = v;
    el.setAttribute('class', v);
  }
};
const setStyle = (el: HTMLElement, k: 'transform' | 'width' | 'opacity' | 'strokeDashoffset', v: string) => {
  const key = '_s' + k;
  if ((el as any)[key] !== v) {
    (el as any)[key] = v;
    (el.style as any)[k] = v;
  }
};

const h = (tag: string, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

export interface HUDState {
  health: number;
  mag: number;
  reserve: number;
  magSize: number;
  weapon: string;
  mode: string;
  spread: number; // degrees
  ads: number;
  scores: [number, number];
  limit: number;
  time: number;
  heading: number; // radians (yaw)
  location: string;
  reloading: boolean;
  sprint: number;
  fps: number;
  outOfBounds: number;
  scoped: boolean;
  hint?: string;
  teamNames: [string, string];
}

export type TacticalId = 'flash' | 'smoke' | 'stun' | 'stim' | 'snapshot' | 'decoy';
export type LethalId = 'frag' | 'tknife' | 'sticky' | 'claymore' | 'c4';
export const LETHALS: { id: LethalId; name: string; count: number; desc: string }[] = [
  { id: 'frag', name: 'FRAG GRENADE', count: 2, desc: 'Cookable (hold G). 3.5 s fuse.' },
  { id: 'sticky', name: 'STICKY GRENADE', count: 2, desc: 'Sticks to walls, floors and people. Arms on throw, 2.3 s fuse — no cooking.' },
  { id: 'claymore', name: 'CLAYMORE', count: 1, desc: 'Hold G to ready it, release to set it down. Tripwire lasers fire it at anyone crossing in front.' },
  { id: 'c4', name: 'C4', count: 2, desc: 'Throw it (sticks to surfaces), detonate whenever you like: double-tap F, or G with none left.' },
  { id: 'tknife', name: 'THROWING KNIFE', count: 2, desc: 'One-hit kill. Fast, flat throw — walk over it to pick it back up.' },
];
export const TACTICALS: { id: TacticalId; name: string; count: number; desc: string }[] = [
  { id: 'flash', name: 'FLASHBANG', count: 2, desc: 'Blinds and deafens anyone facing the blast. Clear a room before you push it.' },
  { id: 'stun', name: 'STUN GRENADE', count: 2, desc: 'Concussion blast: targets move and aim in slow motion for a few seconds.' },
  { id: 'smoke', name: 'SMOKE GRENADE', count: 1, desc: 'A thick smoke screen for ~20 s. Blocks sight lines for everyone, bots included.' },
  { id: 'stim', name: 'STIM', count: 1, desc: 'Auto-injector: heals you fast and boosts movement speed for 10 seconds.' },
  { id: 'snapshot', name: 'SNAPSHOT GRENADE', count: 1, desc: 'A scan pulse that outlines every enemy within 22 m through walls for a few seconds.' },
  { id: 'decoy', name: 'DECOY GRENADE', count: 2, desc: 'Plays fake gunfire for 12 s and puts fake contacts on the enemy minimap.' },
];

export interface UIHandlers {
  onPlay(): void;
  onMultiplayer?(): void;
  onResume(): void;
  onQuit(): void;
  onRestart(): void;
  onLoadout(): void;
  onSettings(): void;
}

export class UI {
  root: HTMLDivElement;
  private hud: HTMLElement;
  private menu: HTMLElement;
  private loading: HTMLElement;
  private pause: HTMLElement;
  private end: HTMLElement;
  private settingsEl: HTMLElement;
  private loadoutEl: HTMLElement;
  private scoreboard: HTMLElement;
  private deathEl: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private feedEl!: HTMLElement;
  private notifyEl!: HTMLElement;
  private dmgEl!: HTMLElement;
  private hitT = 0;
  private lastFeedKey = '';
  // ('mpx' was the old SMG id: carry saved loadouts over to its MP7 replacement)
  primary: WeaponId = ((localStorage.getItem('fjordfront.primary') || '').replace(/^mpx$/, 'mp7') as WeaponId) || 'k416';
  secondary: WeaponId = (localStorage.getItem('fjordfront.secondary') as WeaponId) || 'p80';
  tactical: TacticalId = (localStorage.getItem('fjordfront.tactical') as TacticalId) || 'flash';
  lethal: LethalId = (() => {
    try {
      const v = localStorage.getItem('fjordfront.lethal') as LethalId;
      return LETHALS.some((l) => l.id === v) ? v : 'frag';
    } catch {
      return 'frag';
    }
  })();
  /** five saved loadouts (named); the active one tracks every change made in the loadout screen */
  presets: { name: string; p: WeaponId; s: WeaponId; l: LethalId; t: TacticalId }[] = [];
  activePreset = 0;
  /** multiplayer: per-row ping / speaking for the scoreboard (null offline) */
  sbExtra: ((id: number) => { ping: string; talk: boolean } | null) | null = null;
  private settingsBack: 'menu' | 'pause' = 'menu';
  private loadoutBack: 'menu' | 'pause' = 'menu';

  constructor(root: HTMLDivElement, private handlers: UIHandlers) {
    this.root = root;
    if (!PRIMARIES.includes(this.primary)) this.primary = 'k416';
    if (!SECONDARIES.includes(this.secondary)) this.secondary = 'p80';
    if (!TACTICALS.some((t) => t.id === this.tactical)) this.tactical = 'flash';
    this.loadPresets();
    this.loading = this.buildLoading();
    this.menu = this.buildMenu();
    this.hud = this.buildHUD();
    this.pause = this.buildPause();
    this.end = h('div', 'screen end hidden');
    this.settingsEl = h('div', 'screen settings hidden');
    this.loadoutEl = h('div', 'screen loadout hidden');
    this.scoreboard = h('div', 'scoreboard hidden');
    this.deathEl = h('div', 'death hidden');
    root.append(this.hud, this.scoreboard, this.deathEl, this.menu, this.pause, this.end, this.settingsEl, this.loadoutEl, this.loading);
  }

  // ---------------------------------------------------------------- screens
  private buildLoading() {
    // adopt the loading screen index.html already painted (no blank frame between page and game)
    const pre = document.getElementById('boot');
    if (pre) {
      pre.classList.add('screen', 'loading');
      return pre;
    }
    const e = h('div', 'screen loading', `
      <div class="brand"><div class="flag"></div><h1>FJORDFRONT</h1></div>
      <div class="sub">KVITVIKA · LOFOTEN</div>
      <div class="bar"><div class="fill"></div></div>
      <div class="row"><span class="status">Initialising…</span><span class="pct">0%</span></div>
      <div class="tip">TIP — Double-tap SHIFT for tactical sprint. Crouch while sprinting to slide.</div>`);
    return e;
  }

  private loadP = 0;
  private tipI = 0;
  private tipT = 0;
  private static TIPS = [
    'TIP — Double-tap SHIFT for tactical sprint. Crouch while sprinting to slide.',
    'TIP — Hold Q / E to lean around corners.',
    'TIP — Press N at night to flip your goggles down.',
    'TIP — F3 shows the performance overlay: frame time, GPU time and render resolution.',
    'TIP — Hold V for the combat knife; throwing knives kill in one hit.',
    'TIP — Capture and hold flags: Domination is won on ticks, not kills.',
  ];
  /** progress never moves backwards, the percentage counts with it */
  setLoading(p: number, status: string) {
    this.loadP = Math.max(this.loadP, Math.min(1, p));
    const pct = Math.round(this.loadP * 100);
    (this.loading.querySelector('.fill') as HTMLElement).style.width = `${Math.max(2, pct)}%`;
    (this.loading.querySelector('.status') as HTMLElement).textContent = status;
    const pe = this.loading.querySelector('.pct') as HTMLElement | null;
    if (pe) pe.textContent = `${pct}%`;
    const now = performance.now();
    if (now - this.tipT > 3500) {
      this.tipT = now;
      const tip = this.loading.querySelector('.tip') as HTMLElement | null;
      if (tip && this.tipI++ > 0) tip.textContent = UI.TIPS[this.tipI % UI.TIPS.length];
    }
  }
  hideLoading() {
    this.setLoading(1, 'Ready');
    this.loading.classList.add('fade');
    setTimeout(() => this.loading.classList.add('hidden'), 600);
  }

  private buildMenu() {
    const e = h('div', 'screen menu hidden', `
      <div class="menu-left">
        <div class="brand"><div class="flag"></div><h1>FJORDFRONT</h1></div>
        <div class="sub">DOMINATION · KVITVIKA, NORDLAND</div>
        <nav>
          <button data-a="play" class="primary"><span>DEPLOY</span><small>12 v 12 · AI squads</small></button>
          <button data-a="mp"><span>MULTIPLAYER</span><small>Host or join friends · bots fill the slots</small></button>
          <button data-a="loadout"><span>LOADOUT</span><small class="cur-weapon"></small></button>
          <button data-a="settings"><span>SETTINGS</span><small>Controls · Graphics · Audio</small></button>
          <button data-a="controls"><span>FIELD MANUAL</span><small>Movement & handling</small></button>
        </nav>
        <div class="controls-help hidden">
          <div><b>WASD</b> Move</div><div><b>MOUSE</b> Look / Fire / Aim</div>
          <div><b>SHIFT</b> Sprint · tap again: Tactical sprint</div><div><b>C / CTRL</b> Crouch · while sprinting: Slide</div>
          <div><b>Z</b> Prone · hold C: Prone</div><div><b>SPACE</b> Jump · Mantle · Vault (auto)</div>
          <div><b>R</b> Reload</div><div><b>1 / 2 / Wheel</b> Switch weapon</div>
          <div><b>B</b> Fire mode</div><div><b>I</b> Inspect weapon</div>
          <div><b>F</b> Use: door · zipline · spot enemy</div><div><b>SHIFT (scoped)</b> Hold breath</div>
          <div><b>Q / E</b> Lean left / right (hold)</div><div><b>H</b> Field upgrade (Trophy System)</div>
          <div><b>N</b> Night vision</div><div><b>AIM at a door</b> Peek round it</div>
          <div><b>G</b> Lethal (hold: cook / aim / place)</div><div><b>T</b> Tactical</div>
          <div><b>F F</b> Detonate C4</div><div><b>LMG + prone / ledge</b> Bipod deploys</div>
          <div><b>V</b> Melee</div><div><b>3 / 4 / 5</b> Killstreaks</div>
          <div><b>TAB</b> Scoreboard</div><div><b>ESC</b> Pause · Loadout · Tuning</div>
          <div><b>M</b> Tactical map · zoom, pan, ping, waypoint</div><div><b>X / MIDDLE</b> Ping</div>
        </div>
      </div>
      <div class="menu-right">
        <div class="intel">
          <div class="label">OPERATION BRIEF</div>
          <p>Hostile forces of <b class="red">NORDFRONT</b> have seized the old coastal fort above Kvitvika. Push from the harbour with the <b class="blue">KYSTJEGERNE</b>, take the village and hold the fjord.</p>
          <div class="label">AREA</div>
          <p>Fishing village, rorbuer and docks · Industrial harbour · Two-lane road tunnel with emergency exits up to the ridge · Inlet bridge · WW2 coastal fort</p>
        </div>
      </div>
      <div class="credits">Procedural art · Firearm recordings: Free Firearm Sound Library (CC0) · Voices &amp; effects: ElevenLabs · Music: Stable Audio 2.5 (Stability AI) · FPS arms by DJMaesen (CC BY 4.0) · Kenney Impact Sounds (CC0) · Procedural soldiers &amp; animation · Water normals: three.js</div>`);
    e.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        const a = (b as HTMLElement).dataset.a;
        if (a === 'play') this.handlers.onPlay();
        if (a === 'mp') this.handlers.onMultiplayer?.();
        if (a === 'loadout') this.showLoadout();
        if (a === 'settings') this.showSettings('menu');
        if (a === 'controls') e.querySelector('.controls-help')!.classList.toggle('hidden');
      }),
    );
    this.updateMenuWeapon(e);
    return e;
  }

  private updateMenuWeapon(e = this.menu) {
    const s = e.querySelector('.cur-weapon');
    if (s) s.textContent = `${WEAPONS[this.primary].short} · ${WEAPONS[this.secondary].short} · ${(LETHALS.find((l) => l.id === this.lethal)?.name ?? '').toLowerCase()} · ${TACTICALS.find((t) => t.id === this.tactical)!.name.toLowerCase()}`;
  }

  showMenu(v: boolean) {
    this.menu.classList.toggle('hidden', !v);
  }

  /** Loadout: primary, sidearm, lethal and tactical. From the pause menu it applies on your next spawn (or right away if you just spawned). */
  /** set by the game: 3D weapon preview + silhouette thumbnails for the loadout screen */
  previewFactory: (() => WeaponPreview) | null = null;
  private _preview: WeaponPreview | null = null;
  /** created on first use (the loadout screen): its own WebGL context + environment map are not
   *  something every session should pay for at load, and a second context is a context-loss risk
   *  on low-memory GPUs */
  get preview(): WeaponPreview | null {
    if (!this._preview && this.previewFactory) this._preview = this.previewFactory();
    return this._preview;
  }
  private ldSlot: 'p' | 's' | 'e' = 'p';
  private ldCat = '';

  private loadPresets() {
    const DEF: [string, WeaponId, WeaponId, LethalId, TacticalId][] = [
      ['ASSAULT', 'k416', 'p80', 'frag', 'flash'], ['CLOSE QUARTERS', 'mp7', 'p80', 'semtex' as LethalId, 'stun'],
      ['LONG RANGE', 'ks17' as WeaponId, 'p80', 'claymore' as LethalId, 'smoke'], ['SUPPORT', 'k416', 'p80', 'frag', 'smoke'], ['CUSTOM', 'k416', 'p80', 'frag', 'flash'],
    ];
    let saved: any[] = [];
    try {
      saved = JSON.parse(localStorage.getItem('ff.loadouts') || '[]');
      this.activePreset = Math.max(0, Math.min(4, parseInt(localStorage.getItem('ff.loadout') || '0', 10) || 0));
    } catch {
      /* fresh */
    }
    const okW = (id: string, pool: readonly string[], d: WeaponId) => (pool.includes(id) ? (id as WeaponId) : d);
    const okL = (id: string) => (LETHALS.some((l) => l.id === id) ? (id as LethalId) : 'frag');
    const okT = (id: string) => (TACTICALS.some((t) => t.id === id) ? (id as TacticalId) : 'flash');
    this.presets = DEF.map((d, i) => {
      const v = saved[i];
      if (v) return { name: String(v.name || d[0]).slice(0, 16), p: okW(v.p, PRIMARIES, 'k416'), s: okW(v.s, SECONDARIES, 'p80'), l: okL(v.l), t: okT(v.t) };
      return { name: d[0], p: okW(d[1], PRIMARIES, 'k416'), s: okW(d[2], SECONDARIES, 'p80'), l: okL(d[3]), t: okT(d[4]) };
    });
    // no saved loadouts yet: the current single loadout becomes the first one
    if (!saved.length) Object.assign(this.presets[0], { p: this.primary, s: this.secondary, l: this.lethal, t: this.tactical });
    const a = this.presets[this.activePreset];
    this.primary = a.p;
    this.secondary = a.s;
    this.lethal = a.l;
    this.tactical = a.t;
  }
  private savePresets() {
    try {
      localStorage.setItem('ff.loadouts', JSON.stringify(this.presets));
      localStorage.setItem('ff.loadout', String(this.activePreset));
      localStorage.setItem('fjordfront.primary', this.primary);
      localStorage.setItem('fjordfront.secondary', this.secondary);
      localStorage.setItem('fjordfront.tactical', this.tactical);
      localStorage.setItem('fjordfront.lethal', this.lethal);
    } catch {
      /* storage unavailable */
    }
  }
  /** switch to saved loadout i (applies on the next spawn; the death screen uses this) */
  selectPreset(i: number) {
    const p = this.presets[i];
    if (!p) return;
    this.activePreset = i;
    this.primary = p.p;
    this.secondary = p.s;
    this.lethal = p.l;
    this.tactical = p.t;
    this.savePresets();
    this.updateMenuWeapon();
    this.deathKey = '';
  }

  showLoadout(back: 'menu' | 'pause' = 'menu', note = '') {
    this.loadoutBack = back;
    const e = this.loadoutEl;
    const CATS: { cls: WeaponDef['cls']; label: string }[] = [
      { cls: 'Assault Rifle', label: 'ASSAULT RIFLES' }, { cls: 'SMG', label: 'SMGS' }, { cls: 'LMG', label: 'LMGS' }, { cls: 'Shotgun', label: 'SHOTGUNS' },
      { cls: 'Marksman', label: 'MARKSMAN RIFLES' }, { cls: 'Sniper', label: 'SNIPER RIFLES' }, { cls: 'Pistol', label: 'HANDGUNS' },
    ];
    const CLS_NAME: Record<string, string> = { LMG: 'LIGHT MACHINE GUN', 'Assault Rifle': 'ASSAULT RIFLE', SMG: 'SUBMACHINE GUN', Shotgun: 'SHOTGUN', Marksman: 'MARKSMAN RIFLE', Sniper: 'SNIPER RIFLE', Pistol: 'HANDGUN' };
    const stats = (d: WeaponDef): [string, number][] => [
      ['Damage', (d.damage[0] * d.pellets) / 110],
      ['Fire Rate', d.rpm / 950],
      ['Range', d.range[1] / 300],
      ['Accuracy', 1 - Math.min(1, (d.hipSpread * 0.06 + d.adsSpread * 0.8 + d.bloomMax * 0.05))],
      ['Recoil Control', 1 - Math.min(1, d.recoil.v / 6)],
      ['Mobility', Math.min(1, d.speedMul * 0.75 + d.adsSpeedMul * 0.25)],
      ['Handling', 1 - Math.min(1, d.adsTime / 0.45) * 0.85],
    ];
    const render = () => {
      const slot = this.ldSlot;
      const pool = slot === 'p' ? PRIMARIES : SECONDARIES;
      const cats = CATS.filter((c) => pool.some((id) => WEAPONS[id].cls === c.cls));
      const selId: WeaponId = slot === 's' ? this.secondary : this.primary;
      if (slot !== 'e' && !cats.some((c) => c.cls === this.ldCat)) this.ldCat = WEAPONS[selId].cls;
      const list = pool.filter((id) => WEAPONS[id].cls === this.ldCat);
      const shown: WeaponId = list.includes(selId) ? selId : list[0] ?? selId;
      const d = WEAPONS[shown];
      const card = (id: WeaponId) => {
        const w = WEAPONS[id];
        const eq = id === selId;
        const img = this.preview ? `<img alt="" src="${this.preview.thumbnail(id)}">` : '';
        return `<div class="ldcard ${eq ? 'eq' : ''} ${id === shown ? 'on' : ''}" data-id="${id}">${eq ? '<i class="chk">✓</i>' : ''}<div class="th">${img}</div><div class="cn">${w.short}</div><div class="cs">${CLS_NAME[w.cls]}</div>${eq ? '<div class="eqb">EQUIPPED</div>' : ''}</div>`;
      };
      const ecard = (id: string, name: string, desc: string, count: number, sel: boolean, group: string) =>
        `<div class="ldcard eqp ${sel ? 'eq on' : ''}" data-g="${group}" data-id="${id}">${sel ? '<i class="chk">✓</i>' : ''}<div class="th ic">${icon(id, 'big')}</div><div class="cn">${name}</div><div class="cs">${desc}</div><div class="cs">×${count} PER LIFE</div></div>`;
      const bar = `<div class="ldpresets">${this.presets.map((p, i) => `<button data-preset="${i}" class="${i === this.activePreset ? 'on' : ''}" title="Double-click to rename"><small>${i + 1}</small>${p.name}</button>`).join('')}</div>`;
      const top = `${bar}<div class="ldtop"><div class="ldtitle">${slot === 'p' ? 'PRIMARY WEAPON' : slot === 's' ? 'SIDEARM' : 'EQUIPMENT'} <small>${back === 'pause' ? 'changes apply on your next spawn' : 'choose your kit'}</small></div>
        <div class="ldslots">
          <button data-slot="p" class="${slot === 'p' ? 'on' : ''}"><small>PRIMARY</small>${WEAPONS[this.primary].short}</button>
          <button data-slot="s" class="${slot === 's' ? 'on' : ''}"><small>SIDEARM</small>${WEAPONS[this.secondary].short}</button>
          <button data-slot="e" class="${slot === 'e' ? 'on' : ''}"><small>EQUIPMENT</small>${LETHALS.find((l) => l.id === this.lethal)?.name.replace(' GRENADE', '') ?? ''} · ${TACTICALS.find((t) => t.id === this.tactical)?.name ?? ''}</button>
        </div></div>`;
      if (slot === 'e') {
        e.innerHTML = `<div class="ld">${top}${note ? `<div class="lnote">${note}</div>` : ''}
          <div class="ldeq"><div class="lsec">LETHAL</div><div class="ldrow">${LETHALS.map((l) => ecard(l.id, l.name, l.desc, l.count, this.lethal === l.id, 'l')).join('')}</div>
          <div class="lsec">TACTICAL</div><div class="ldrow">${TACTICALS.map((t) => ecard(t.id, t.name, t.desc, t.count, t.id === this.tactical, 't')).join('')}</div>
          <div class="lsec">FIELD UPGRADE</div><div class="ldrow">${ecard('trophy', 'TROPHY SYSTEM', 'Press H to deploy. Shoots down up to 3 enemy grenades, C4, sticky grenades and throwing knives within 7.5 m. Recharges over time.', 1, true, 'f')}</div></div>
          <div class="ldbot"><button class="primary" data-a="done">CONFIRM</button></div></div>`;
      } else {
        e.innerHTML = `<div class="ld">${top}${note ? `<div class="lnote">${note}</div>` : ''}
          <div class="ldmain">
            <div class="ldinfo"><div class="ldcls">${CLS_NAME[d.cls]}</div><div class="ldname">${d.name.toUpperCase()}</div><p>${d.desc}</p>
              <div class="ldstats">${stats(d).map(([k, v]) => `<div class="ldst"><span>${k}</span><b><i style="width:${Math.round(Math.max(0.04, Math.min(1, v)) * 100)}%"></i></b></div>`).join('')}</div>
              <div class="ldnums"><div><small>ROUNDS</small>${d.mag}</div><div><small>RESERVE</small>${d.reserve}</div><div><small>RPM</small>${d.rpm}</div></div>
            </div>
            <div class="ldview"></div>
          </div>
          <div class="ldtabs">${cats.map((c) => `<button data-cat="${c.cls}" class="${c.cls === this.ldCat ? 'on' : ''}">${c.label}</button>`).join('')}</div>
          <div class="ldcar">${list.map(card).join('')}</div>
          <div class="ldbot"><span class="ldhint">Click a weapon to equip it</span><button class="primary" data-a="done">CONFIRM</button></div></div>`;
        if (this.preview) this.preview.show(e.querySelector('.ldview') as HTMLElement, shown);
      }
      e.querySelectorAll('[data-slot]').forEach((b) => b.addEventListener('click', () => { this.ldSlot = (b as HTMLElement).dataset.slot as 'p' | 's' | 'e'; this.ldCat = ''; render(); }));
      e.querySelectorAll('[data-preset]').forEach((b) => {
        const i = +(b as HTMLElement).dataset.preset!;
        b.addEventListener('click', () => {
          this.selectPreset(i);
          this.ldCat = '';
          render();
        });
        b.addEventListener('dblclick', () => {
          const n = prompt('Loadout name', this.presets[i].name);
          if (n && n.trim()) {
            this.presets[i].name = n.trim().toUpperCase().slice(0, 16);
            this.savePresets();
            render();
          }
        });
      });
      e.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => { this.ldCat = (b as HTMLElement).dataset.cat!; render(); }));
      e.querySelectorAll('.ldcard').forEach((c) =>
        c.addEventListener('click', () => {
          const el = c as HTMLElement;
          const id = el.dataset.id!;
          if (this.ldSlot === 'p') this.primary = id as WeaponId;
          else if (this.ldSlot === 's') this.secondary = id as WeaponId;
          else if (el.dataset.g === 't') this.tactical = id as TacticalId;
          else if (el.dataset.g === 'l') this.lethal = id as LethalId;
          else return;
          Object.assign(this.presets[this.activePreset], { p: this.primary, s: this.secondary, l: this.lethal, t: this.tactical });
          this.savePresets();
          render();
        }),
      );
      e.querySelector('[data-a=done]')!.addEventListener('click', () => {
        e.classList.add('hidden');
        this.preview?.stop();
        this.updateMenuWeapon();
        this.handlers.onLoadout();
        if (this.loadoutBack === 'pause') this.pause.classList.remove('hidden');
      });
    };
    e.classList.remove('hidden');
    render();
  }

  showSettings(back: 'menu' | 'pause') {
    this.settingsBack = back;
    const e = this.settingsEl;
    const s = Settings.data;
    const slider = (k: keyof SettingsData, label: string, min: number, max: number, step: number, fmt = (v: number) => v.toFixed(2)) =>
      `<label class="opt"><span>${label}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${s[k]}"><em>${fmt(s[k] as number)}</em></label>`;
    const toggle = (k: keyof SettingsData, label: string) => `<label class="opt"><span>${label}</span><input type="checkbox" data-k="${k}" ${s[k] ? 'checked' : ''}><i class="tg"></i></label>`;
    const select = (k: keyof SettingsData, label: string, opts: [string, string][]) =>
      `<label class="opt"><span>${label}</span><select data-k="${k}">${opts.map(([v, l]) => `<option value="${v}" ${String(s[k]) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
    e.innerHTML = `<div class="panel"><div class="ptitle">SETTINGS</div>
      <div class="tabs"><button data-t="g" class="on">GAMEPLAY</button><button data-t="c">CONTROLS</button><button data-t="v">GRAPHICS</button><button data-t="a">AUDIO</button><button data-t="m">MULTIPLAYER</button></div>
      <div class="tab" data-t="g">
        ${slider('sensitivity', 'Mouse sensitivity', 0.1, 4, 0.05)}
        ${slider('adsSensitivity', 'ADS sensitivity multiplier', 0.3, 1.5, 0.05)}
        ${slider('scopeSensitivity', 'Sniper scope sensitivity', 0.05, 1, 0.01)}
        ${slider('fov', 'Field of view (horizontal)', 65, 115, 1, (v) => v.toFixed(0))}
        ${slider('weaponFov', 'Weapon field of view', 36, 64, 1, (v) => v.toFixed(0))}
        ${slider('armsFov', 'Arms field of view', 36, 70, 1, (v) => v.toFixed(0))}
        ${select('adsFov', 'ADS field of view', [['affected', 'Affected (scales with FOV)'], ['independent', 'Independent (fixed 80° base)']])}
        ${toggle('invertY', 'Invert Y axis')}
        ${toggle('toggleCrouch', 'Toggle crouch')}
        ${toggle('toggleAds', 'Toggle aim (ADS)')}
        ${select('botDifficulty', 'Bot difficulty', [['recruit', 'Recruit'], ['regular', 'Regular'], ['veteran', 'Veteran']])}
      </div>
      <div class="tab hidden" data-t="v">
        ${toggle('autoQuality', 'Automatic graphics (preset from your hardware, adapts to hold the frame rate)')}
        ${select('quality', 'Quality preset', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']])}
        <div class="opt"><span></span><small style="color:var(--dim);grid-column:span 2">Lights, grass, terrain detail and weather particles follow the preset after reloading the page.</small></div>
        ${slider('renderScale', 'Render scale', 0.5, 1, 0.05)}
        ${toggle('dynamicRes', 'Dynamic resolution (hold 60 fps)')}
        ${toggle('hiDpi', 'Full HiDPI resolution (sharper, much slower on 4K / laptop screens)')}
        ${toggle('perfOverlay', 'Performance overlay (F3)')}
        ${toggle('shadows', 'Shadows')}
        ${select('shadowRes', 'Shadow resolution', [['1024', '1024'], ['2048', '2048'], ['4096', '4096']])}
        ${toggle('ao', 'Ambient occlusion (N8AO)')}
        ${toggle('bloom', 'Bloom')}
        ${toggle('antialias', 'Anti-aliasing (SMAA)')}
        ${toggle('motionBlur', 'Motion blur')}
        ${toggle('dof', 'Aim depth of field')}
        ${slider('grassDensity', 'Grass density (next match)', 0.2, 1.5, 0.1)}
        ${select('mapVariant', 'Map variant', [['random', 'Random per match'], ['autumn', 'Autumn'], ['winter', 'Winter (snow-covered)']])}
        ${select('weather', 'Weather', [['auto', 'Random'], ['clear', 'Broken clouds'], ['overcast', 'Overcast'], ['rain', 'Rain'], ['snow', 'Snow showers']])}
        ${select('timeOfDay', 'Time of day', [['dynamic', 'Dynamic (time passes)'], ['dawn', 'Morning'], ['day', 'Midday'], ['golden', 'Golden hour'], ['blue', 'Blue hour'], ['night', 'Night — northern lights']])}
        ${toggle('godRays', 'Sun shafts (god rays)')}
        ${toggle('showFps', 'Show FPS')}
      </div>
      <div class="tab hidden" data-t="c">
        <div class="lsub">SENSITIVITY FROM ANOTHER GAME</div>
        <div class="opt conv"><span>Same turn speed as</span><span class="convrow"><select class="cg">
          <option value="0.022">CS2 / CS:GO / Apex Legends</option><option value="0.07">Valorant</option><option value="0.0066">Overwatch 2 / Call of Duty (MW / BO)</option><option value="0.12605">Fjordfront (another computer)</option></select>
          <input class="cv" type="number" step="0.01" min="0" placeholder="their sens"><button data-a="conv">APPLY</button></span></div>
        <div class="opt"><span></span><small class="convout" style="color:var(--dim);grid-column:span 2">Same mouse DPI: the same hand movement turns the same amount. We turn ${(0.0022 * 180 / Math.PI).toFixed(4)}° per mouse count × sensitivity.</small></div>
        <div class="lsub">CONTROLLER</div>
        ${slider('padSensitivity', 'Look speed', 0.3, 2.5, 0.05)}
        ${slider('padDeadzone', 'Stick deadzone', 0.03, 0.3, 0.01)}
        ${toggle('padInvertY', 'Invert look (controller)')}
        ${toggle('aimAssist', 'Aim assist (controller only: slow-down + rotational, needs a visible target)')}
        <div class="lsub">KEYS <small>click a key, then press the new one (Esc cancels, Backspace clears)</small></div>
        <div class="binds">${ACTION_LABELS.map(([a, l]) => `<div class="bind"><span>${l}</span><button data-bind="${a}">${keysFor(a).map(keyLabel).join(' / ') || '—'}</button></div>`).join('')}</div>
        <div class="row"><button data-a="resetkeys">RESET KEYS</button></div>
      </div>
      <div class="tab hidden" data-t="m">
        <div class="lsub">VOICE CHAT</div>
        ${select('voiceMode', 'Talk', [['ptt', 'Push to talk (K by default)'], ['open', 'Open mic (voice activated)']])}
        ${select('voiceChannel', 'Channel', [['team', 'Team: only your side hears you'], ['proximity', 'Proximity: anyone near you, fading with distance']])}
        ${slider('voiceVolume', 'Voice volume', 0, 1.5, 0.05)}
        <div class="opt"><span></span><small style="color:var(--dim);grid-column:span 2">Turn voice on in a room with /voice (needs the microphone). /mute name silences a player.</small></div>
        ${toggle('profanityFilter', 'Filter swear words in chat')}
        <div class="lsub">CONNECTION <small>peer-to-peer; a TURN relay helps on strict school / office / mobile networks</small></div>
        <label class="opt"><span>TURN server</span><input class="ice" data-ice="turnUrl" placeholder="turn:relay.example.org:3478" spellcheck="false"></label>
        <label class="opt"><span>TURN username</span><input class="ice" data-ice="turnUser" spellcheck="false" autocomplete="off"></label>
        <label class="opt"><span>TURN password</span><input class="ice" data-ice="turnPass" type="password" autocomplete="off"></label>
        <label class="opt"><span>Relay only (hides your IP, a little more latency)</span><input type="checkbox" class="ice" data-ice="relayOnly"><i class="tg"></i></label>
        <div class="row"><button data-a="icetest">TEST CONNECTION</button></div>
        <div class="icemsg"></div>
      </div>
      <div class="tab hidden" data-t="a">
        ${slider('masterVolume', 'Master volume', 0, 1, 0.05)}
        ${slider('sfxVolume', 'Effects', 0, 1, 0.05)}
        ${slider('ambienceVolume', 'Ambience', 0, 1, 0.05)}
        ${slider('musicVolume', 'Music', 0, 1, 0.05)}
      </div>
      <div class="row"><button data-a="reset">RESET DEFAULTS</button><button class="primary" data-a="back">BACK</button></div></div>`;
    e.classList.remove('hidden');
    e.querySelectorAll('.tabs button').forEach((b) =>
      b.addEventListener('click', () => {
        const t = (b as HTMLElement).dataset.t;
        e.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
        e.querySelectorAll('.tab').forEach((x) => x.classList.toggle('hidden', (x as HTMLElement).dataset.t !== t));
      }),
    );
    this.wireControls(e);
    e.querySelectorAll('input[data-k],select[data-k]').forEach((inp) =>
      inp.addEventListener('input', () => {
        const el = inp as HTMLInputElement;
        const k = el.dataset.k as keyof SettingsData;
        let v: any = el.type === 'checkbox' ? el.checked : el.type === 'range' ? parseFloat(el.value) : el.value;
        if (k === 'shadowRes') v = parseInt(v, 10);
        if (k === 'quality') {
          // choosing a preset by hand takes over from the automatic choice
          Settings.data.autoQuality = false;
          Settings.applyPreset(v as Quality);
          this.showSettings(this.settingsBack);
          e.querySelector('[data-t=v]')?.dispatchEvent(new Event('click'));
          (e.querySelector('.tabs [data-t=v]') as HTMLElement)?.click();
          this.handlers.onSettings();
          return;
        }
        Settings.set(k, v as never);
        const em = el.parentElement?.querySelector('em');
        if (em) em.textContent = k === 'fov' || k === 'weaponFov' || k === 'armsFov' ? String(v) : (+v).toFixed(2);
        this.handlers.onSettings();
      }),
    );
    e.querySelector('[data-a=back]')!.addEventListener('click', () => {
      e.classList.add('hidden');
      if (this.settingsBack === 'pause') this.pause.classList.remove('hidden');
    });
    e.querySelector('[data-a=reset]')!.addEventListener('click', () => {
      Settings.reset();
      this.showSettings(this.settingsBack);
      this.handlers.onSettings();
    });
  }

  /** Controls / Multiplayer tabs: rebinding, sensitivity converter, TURN settings and test */
  private wireControls(e: HTMLElement) {
    // ---- key rebinding
    e.querySelectorAll('[data-bind]').forEach((b) =>
      b.addEventListener('click', () => {
        const btn = b as HTMLButtonElement;
        const a = btn.dataset.bind as Action;
        btn.textContent = 'PRESS A KEY…';
        btn.classList.add('wait');
        const done = (code: string | null) => {
          window.removeEventListener('keydown', kd, true);
          window.removeEventListener('mousedown', md, true);
          btn.classList.remove('wait');
          if (code !== null) {
            const kb = { ...(Settings.data.keybinds ?? {}) };
            if (code === '') kb[a] = [];
            else {
              // a key does one thing: take it off any other action
              for (const [o] of ACTION_LABELS) {
                if (o === a) continue;
                const ks = keysFor(o);
                if (ks.includes(code)) kb[o] = ks.filter((k) => k !== code);
              }
              kb[a] = [code];
            }
            Settings.set('keybinds', kb);
            applyKeybinds();
          }
          e.querySelectorAll('[data-bind]').forEach((x) => {
            const ac = (x as HTMLElement).dataset.bind as Action;
            x.textContent = keysFor(ac).map(keyLabel).join(' / ') || '—';
          });
        };
        const kd = (ev: KeyboardEvent) => {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          done(ev.code === 'Escape' ? null : ev.code === 'Backspace' ? '' : ev.code);
        };
        const md = (ev: MouseEvent) => {
          if (ev.target === btn && ev.button === 0) return;
          ev.preventDefault();
          ev.stopImmediatePropagation();
          done('Mouse' + ev.button);
        };
        setTimeout(() => {
          window.addEventListener('keydown', kd, true);
          window.addEventListener('mousedown', md, true);
        }, 0);
      }),
    );
    e.querySelector('[data-a=resetkeys]')?.addEventListener('click', () => {
      Settings.set('keybinds', {});
      applyKeybinds();
      e.querySelectorAll('[data-bind]').forEach((x) => (x.textContent = keysFor((x as HTMLElement).dataset.bind as Action).map(keyLabel).join(' / ')));
    });
    // ---- sensitivity converter: their yaw per count × their sens = ours
    e.querySelector('[data-a=conv]')?.addEventListener('click', () => {
      const yaw = parseFloat((e.querySelector('.cg') as HTMLSelectElement).value);
      const v = parseFloat((e.querySelector('.cv') as HTMLInputElement).value);
      const out = e.querySelector('.convout') as HTMLElement;
      if (!(v > 0)) {
        out.textContent = 'Type your sensitivity from that game first.';
        return;
      }
      const ours = Math.max(0.05, Math.min(10, (v * yaw) / ((0.0022 * 180) / Math.PI)));
      Settings.set('sensitivity', Math.round(ours * 1000) / 1000);
      const sl = e.querySelector('[data-k=sensitivity]') as HTMLInputElement | null;
      if (sl) {
        sl.value = String(ours);
        const em = sl.parentElement?.querySelector('em');
        if (em) em.textContent = ours.toFixed(2);
      }
      out.textContent = `Mouse sensitivity set to ${ours.toFixed(3)} (${((360 / (0.0022 * ours * 180 / Math.PI)) / 400 * 2.54).toFixed(1)} cm per 360° at 400 DPI · ${((360 / (0.0022 * ours * 180 / Math.PI)) / 800 * 2.54).toFixed(1)} cm at 800 DPI).`;
      this.handlers.onSettings();
    });
    // ---- TURN relay
    const ice = loadIce();
    e.querySelectorAll('.ice').forEach((x) => {
      const el = x as HTMLInputElement;
      const k = el.dataset.ice as keyof typeof ice;
      if (el.type === 'checkbox') el.checked = !!ice[k];
      else el.value = String(ice[k] ?? '');
      el.addEventListener('input', () => {
        const cur = loadIce();
        (cur as any)[k] = el.type === 'checkbox' ? el.checked : el.value.trim();
        saveIce(cur);
      });
      el.addEventListener('keydown', (ev) => ev.stopPropagation());
    });
    e.querySelector('[data-a=icetest]')?.addEventListener('click', async () => {
      const m = e.querySelector('.icemsg') as HTMLElement;
      m.textContent = 'Testing…';
      const r = await testIce(5000);
      m.innerHTML = `Local: ${r.host ? '✓' : '✗'} · STUN (direct through NAT): ${r.srflx ? '✓' : '✗'} · TURN relay: ${r.relay ? '✓' : loadIce().turnUrl ? '✗' : 'not set'}<br>${r.verdict}`;
    });
  }

  private buildPause() {
    const e = h('div', 'screen pause hidden', `<div class="panel small"><div class="ptitle">PAUSED</div>
      <button class="primary" data-a="resume">RESUME</button><button data-a="loadout">LOADOUT</button><button data-a="settings">SETTINGS</button><button data-a="tuning">MOVEMENT TUNING</button><button data-a="quit">QUIT TO MENU</button>
      <div class="hint">Click RESUME to re-capture the mouse</div></div>`);
    e.querySelector('[data-a=resume]')!.addEventListener('click', () => this.handlers.onResume());
    e.querySelector('[data-a=loadout]')!.addEventListener('click', () => {
      e.classList.add('hidden');
      this.showLoadout('pause');
    });
    e.querySelector('[data-a=settings]')!.addEventListener('click', () => {
      e.classList.add('hidden');
      this.showSettings('pause');
    });
    e.querySelector('[data-a=quit]')!.addEventListener('click', () => this.handlers.onQuit());
    e.querySelector('[data-a=tuning]')!.addEventListener('click', () => {
      e.classList.add('hidden');
      this.showTuning();
    });
    return e;
  }

  /** Live movement tuning (values persist in localStorage). */
  tuning: { values: Record<string, number>; defaults: Record<string, number> } | null = null;
  showTuning() {
    const t = this.tuning;
    if (!t) return;
    const e = this.settingsEl;
    const range: Record<string, [number, number, number]> = {
      walk: [2, 8, 0.1], crouch: [1, 5, 0.1], prone: [0.3, 2, 0.05], sprint: [4, 11, 0.1], tactical: [5, 13, 0.1], adsMul: [0.3, 1, 0.02],
      accel: [2, 30, 0.5], decel: [2, 30, 0.5], sprintAccel: [2, 20, 0.5], airAccel: [0, 6, 0.1], gravity: [9, 35, 0.5], jumpVel: [3, 10, 0.1],
      slideBoost: [0, 6, 0.1], slideMin: [5, 15, 0.1], slideMax: [6, 18, 0.1], slideFriction: [1, 15, 0.2], slideMaxTime: [0.3, 2.5, 0.05],
      slideEndSpeed: [1, 6, 0.1], tacFuel: [1, 8, 0.1], tacRecharge: [0.5, 6, 0.1], coyote: [0, 0.3, 0.01], jumpBuffer: [0, 0.3, 0.01],
    };
    e.innerHTML = `<div class="panel tuning"><div class="ptitle">MOVEMENT TUNING <small>changes apply instantly</small></div>
      ${Object.keys(t.values).map((k) => {
        const [mn, mx, st] = range[k] ?? [0, t.defaults[k] * 3 || 1, 0.01];
        return `<label class="opt"><span>${k}</span><input type="range" data-k="${k}" min="${mn}" max="${mx}" step="${st}" value="${t.values[k]}"><em>${t.values[k].toFixed(2)}</em></label>`;
      }).join('')}
      <div class="row"><button data-a="reset">RESET</button><button class="primary" data-a="back">BACK</button></div></div>`;
    e.classList.remove('hidden');
    e.querySelectorAll('input').forEach((inp) =>
      inp.addEventListener('input', () => {
        const k = (inp as HTMLInputElement).dataset.k!;
        t.values[k] = parseFloat((inp as HTMLInputElement).value);
        inp.parentElement!.querySelector('em')!.textContent = t.values[k].toFixed(2);
        localStorage.setItem('fjordfront.tuning', JSON.stringify(t.values));
      }),
    );
    e.querySelector('[data-a=reset]')!.addEventListener('click', () => {
      Object.assign(t.values, t.defaults);
      localStorage.removeItem('fjordfront.tuning');
      this.showTuning();
    });
    e.querySelector('[data-a=back]')!.addEventListener('click', () => {
      e.classList.add('hidden');
      this.pause.classList.remove('hidden');
    });
  }

  get hudEl() {
    return this.hud;
  }

  showPause(v: boolean) {
    this.pause.classList.toggle('hidden', !v);
    if (!v) this.settingsEl.classList.add('hidden');
  }

  showEnd(winner: 0 | 1 | -1, myTeam: 0 | 1, rows: CombatantState[], scores: [number, number], names: [string, string]) {
    const won = winner === myTeam;
    const title = winner === -1 ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT';
    this.end.innerHTML = `<div class="panel wide"><div class="ptitle big ${won ? 'win' : winner === -1 ? '' : 'loss'}">${title}</div>
      <div class="final"><span class="blue">${names[0]} ${scores[0]}</span> — <span class="red">${scores[1]} ${names[1]}</span></div>
      ${this.tableHTML(rows, names)}
      <div class="row"><button class="primary" data-a="again">PLAY AGAIN</button><button data-a="menu">MAIN MENU</button></div></div>`;
    this.end.classList.remove('hidden');
    this.end.querySelector('[data-a=again]')!.addEventListener('click', () => {
      this.end.classList.add('hidden');
      this.handlers.onRestart();
    });
    this.end.querySelector('[data-a=menu]')!.addEventListener('click', () => {
      this.end.classList.add('hidden');
      this.handlers.onQuit();
    });
  }
  hideEnd() {
    this.end.classList.add('hidden');
  }

  private tableHTML(rows: CombatantState[], names: [string, string]) {
    const team = (t: 0 | 1) => {
      const r = rows.filter((x) => x.team === t).sort((a, b) => b.score - a.score);
      const net = !!this.sbExtra?.(-1);
      const ex = (id: number) => (this.sbExtra ? this.sbExtra(id) : null);
      return `<div class="sbteam ${t === 0 ? 'blue' : 'red'} ${net ? 'net' : ''}"><div class="sbh"><span>${names[t]}</span><span>K</span><span>D</span><span>SCORE</span>${net ? '<span>PING</span>' : ''}</div>${r
        .map((x) => {
          const e = ex(x.id);
          return `<div class="sbr ${x.isPlayer ? 'me' : ''} ${x.alive ? '' : 'dead'}"><span>${e?.talk ? '<i class="spk"></i>' : ''}${x.name}</span><span>${x.kills}</span><span>${x.deaths}</span><span>${x.score}</span>${net ? `<span class="pg">${e?.ping ?? ''}</span>` : ''}</div>`;
        })
        .join('')}</div>`;
    };
    return `<div class="sbwrap">${team(0)}${team(1)}</div>`;
  }

  setScoreboard(v: boolean, rows?: CombatantState[], names?: [string, string]) {
    this.scoreboard.classList.toggle('hidden', !v);
    if (v && rows && names) this.scoreboard.innerHTML = this.tableHTML(rows, names);
  }

  // ---------------------------------------------------------------- HUD
  private buildHUD() {
    const e = h('div', 'hud hidden');
    e.innerHTML = `
      <div class="top">
        <div class="scorebar">
          <div class="team blue"><span class="tn"></span><b class="s0">0</b><div class="prog"><i class="p0"></i></div></div>
          <div class="clock">10:00</div>
          <div class="team red"><div class="prog"><i class="p1"></i></div><b class="s1">0</b><span class="tn"></span></div>
        </div>
        <div class="flags"></div>
        <div class="compass"><div class="strip"></div><div class="needle"></div></div>
        <div class="loc"></div>
      </div>
      <div class="crosshair"><i class="l"></i><i class="r"></i><i class="t"></i><i class="b"></i><i class="dot"></i></div>
      <div class="hitmarker"><i></i><i></i><i></i><i></i></div>
      <div class="dmg"></div>
      <div class="feed"></div>
      <div class="notify"></div>
      <div class="killtext"><b class="kx"></b><div class="kr"></div></div>
      <div class="prompt"></div>
      <div class="capbar hidden"><div class="cl"></div><div class="ct"></div><div class="cb"><i></i></div></div>
      <div class="flagmarks"></div>
      <div class="streaks"></div>
      <div class="nades"></div>
      <div class="health"><div class="hb"><i class="hf"></i></div><span class="hv">100</span></div>
      <div class="ammo"><div class="wn"></div><div class="nums"><b class="mag">30</b><span class="res">/ 120</span></div><div class="pips"></div><div class="fm"></div></div>
      <div class="fps hidden"></div>
      <div class="scope hidden"><div class="ring"></div></div>`;
    const q = (s: string) => e.querySelector(s) as HTMLElement;
    for (const k of ['s0', 's1', 'p0', 'p1', 'clock', 'strip', 'loc', 'crosshair', 'hitmarker', 'hf', 'hv', 'mag', 'res', 'wn', 'fm', 'pips', 'prompt', 'fps', 'scope']) this.els[k] = q('.' + k);
    this.feedEl = q('.feed');
    this.notifyEl = q('.notify');
    this.dmgEl = q('.dmg');
    // compass ticks (each degree = 4px)
    const strip = this.els.strip;
    let html = '';
    for (let d = -360; d <= 720; d += 15) {
      const deg = ((d % 360) + 360) % 360;
      const lab = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }[deg as 0];
      html += `<span style="left:${(d + 360) * 4}px" class="${lab ? 'c' : ''}">${lab ?? deg}</span>`;
    }
    strip.innerHTML = html;
    return e;
  }

  showHUD(v: boolean) {
    this.hud.classList.toggle('hidden', !v);
  }

  updateHUD(s: HUDState, dt: number) {
    const e = this.els;
    setText(e.s0, String(s.scores[0]));
    setText(e.s1, String(s.scores[1]));
    setStyle(e.p0, 'width', `${((s.scores[0] / s.limit) * 100).toFixed(1)}%`);
    setStyle(e.p1, 'width', `${((s.scores[1] / s.limit) * 100).toFixed(1)}%`);
    const m = Math.floor(s.time / 60), sec = Math.floor(s.time % 60);
    setText(e.clock, `${m}:${String(sec).padStart(2, '0')}`);
    e.clock.classList.toggle('low', s.time < 60);
    const tn = this.hud.querySelectorAll('.tn');
    setText(tn[0], s.teamNames[0]);
    setText(tn[1], s.teamNames[1]);
    // compass: heading in degrees, 0 = north (-Z)
    let deg = ((-s.heading * 180) / Math.PI) % 360;
    if (deg < 0) deg += 360;
    setStyle(e.strip, 'transform', `translateX(${(-(deg + 360) * 4).toFixed(1)}px)`);
    setText(e.loc, s.location.toUpperCase());
    // crosshair
    const gap = 6 + s.spread * 9;
    const ch = e.crosshair;
    const gs = `${gap.toFixed(1)}px`;
    if ((ch as any)._gap !== gs) {
      (ch as any)._gap = gs;
      ch.style.setProperty('--gap', gs);
    }
    setStyle(ch, 'opacity', String(Math.max(0, 1 - s.ads * 2.5) * (s.sprint > 0.5 ? 0.0 : 1)));
    // hitmarker
    this.hitT = Math.max(0, this.hitT - dt);
    setStyle(e.hitmarker, 'opacity', '0');
    // health
    setStyle(e.hf, 'width', `${s.health.toFixed(0)}%`);
    e.hf.classList.toggle('low', s.health < 35);
    setText(e.hv, String(Math.ceil(s.health)));
    // ammo
    setText(e.mag, s.magSize > 0 ? String(s.mag) : '∞');
    e.mag.classList.toggle('low', s.mag <= Math.ceil(s.magSize * 0.25));
    setText(e.res, s.magSize > 0 ? `/ ${s.reserve}` : '');
    setText(e.wn, s.weapon);
    setText(e.fm, s.mode);
    const pipKey = `${s.mag}/${s.magSize}`;
    if (e.pips.dataset.k !== pipKey) {
      e.pips.dataset.k = pipKey;
      e.pips.innerHTML = Array.from({ length: Math.min(s.magSize, 40) }, (_, i) => `<i class="${i < s.mag ? '' : 'e'}"></i>`).join('');
    }
    // prompt
    let prompt = '';
    if (s.outOfBounds > 0) prompt = `<span class="warn">RETURN TO THE COMBAT AREA</span> ${Math.ceil(s.outOfBounds)}`;
    else if (s.hint) prompt = `<span class="dim">${s.hint}</span>`;
    else if (s.reloading) prompt = 'RELOADING';
    else if (s.magSize > 0 && s.mag === 0 && s.reserve === 0) prompt = '<span class="warn">NO AMMO</span>';
    else if (s.magSize > 0 && s.mag <= Math.ceil(s.magSize * 0.2)) prompt = '<span class="dim">[R] RELOAD</span>';
    setHTML(e.prompt, prompt);
    e.fps.classList.toggle('hidden', !Settings.data.showFps);
    if (Settings.data.showFps) setText(e.fps, `${Math.round(s.fps)} FPS`);
    e.scope.classList.toggle('hidden', !s.scoped);
    // damage indicators fade
    this.dmgEl.querySelectorAll('i').forEach((i) => {
      const el = i as HTMLElement;
      const life = parseFloat(el.dataset.life || '0') - dt;
      el.dataset.life = String(life);
      el.style.opacity = String(Math.max(0, Math.min(1, life)));
      if (life <= 0) el.remove();
    });
  }

  /** MW-style hitmarker: pops on every hit, scales with damage, red X on kills. */
  hitmarker(kill: boolean, head: boolean, damage = 30, kind: '' | 'limb' | 'through' | 'low' = '') {
    // every hit gets its own marker: rapid hits stack and overlap instead of restarting one
    const tpl = this.els.hitmarker;
    const el = tpl.cloneNode(true) as HTMLElement;
    el.className = `hitmarker live ${kill ? 'kill' : ''} ${head ? 'head' : ''} ${kind}`;
    el.style.opacity = '';
    el.style.setProperty('--hs', String(Math.min(1.6, 0.85 + damage / 90) * (kill ? 1.35 : 1)));
    el.style.setProperty('--hr', `${((Math.random() - 0.5) * 6).toFixed(1)}deg`);
    el.style.animationDuration = kill ? '0.55s' : '0.3s';
    tpl.parentElement!.appendChild(el);
    this.liveHits.push(el);
    while (this.liveHits.length > 14) this.liveHits.shift()!.remove();
    el.addEventListener('animationend', () => {
      el.remove();
      const i = this.liveHits.indexOf(el);
      if (i >= 0) this.liveHits.splice(i, 1);
    });
  }
  private liveHits: HTMLElement[] = [];

  /** Score ticker under the crosshair: accumulates quick kills, lists the reasons. */
  private kt = { pts: 0, reasons: [] as string[], timer: 0 };
  /** Small "+XP" and reason lines next to the hitmarker; kills within a short window accumulate. */
  killText(points: number, reasons: string[]) {
    const box = this.hud.querySelector('.killtext') as HTMLElement;
    const k = this.kt;
    if (!box.classList.contains('on')) {
      k.pts = 0;
      k.reasons = [];
    }
    k.pts += points;
    for (const r of reasons) if (!k.reasons.includes(r)) k.reasons.push(r);
    while (k.reasons.length > 4) k.reasons.shift();
    setText((box.querySelector('.kx') as HTMLElement), `+${k.pts} XP`);
    (box.querySelector('.kr') as HTMLElement).innerHTML = k.reasons.map((r) => `<div>${r}</div>`).join('');
    box.classList.add('on');
    clearTimeout(k.timer);
    k.timer = window.setTimeout(() => box.classList.remove('on'), 2600);
  }

  scoreEvent(points: number, label: string, kill = true) {
    // all score feedback goes through the small text by the crosshair
    if (!kill) return this.killText(points, [label]);
    return this.killText(points, []);
  }




  /** Domination HUD: flag strip under the score bar, in-world flag markers, capture bar. */
  updateFlags(
    flags: { letter: string; rel: 'f' | 'e' | 'n'; cap: 'f' | 'e' | 'n'; progress: number; contested: boolean }[],
    marks: { x: number; y: number; letter: string; rel: 'f' | 'e' | 'n'; dist: number; edge: boolean; here: boolean }[],
    cap: { text: string; progress: number; rel: 'f' | 'e' | 'n'; letter: string } | null,
  ) {
    const fe = this.hud.querySelector('.flags') as HTMLElement;
    if (fe.children.length !== flags.length) fe.innerHTML = flags.map(() => `<div class="fl"><svg viewBox="0 0 36 36"><circle class="bg" cx="18" cy="18" r="15"/><circle class="pr" cx="18" cy="18" r="15"/></svg><b></b></div>`).join('');
    flags.forEach((f, i) => {
      const el = fe.children[i] as HTMLElement;
      setCls(el, `fl ${f.rel} ${f.contested ? 'contested' : ''}`);
      setText((el.querySelector('b') as HTMLElement), f.letter);
      const pr = el.querySelector('.pr') as SVGCircleElement;
      setCls(pr, `pr ${f.cap}`);
      setStyle(pr as unknown as HTMLElement, 'strokeDashoffset', (94.25 * (1 - f.progress)).toFixed(1));
    });
    const me = this.hud.querySelector('.flagmarks') as HTMLElement;
    if (me.children.length !== marks.length) me.innerHTML = marks.map(() => `<div class="fm"><b></b><span></span></div>`).join('');
    marks.forEach((m, i) => {
      const el = me.children[i] as HTMLElement;
      setCls(el, `fm ${m.rel} ${m.edge ? 'edge' : ''} ${m.here ? 'here' : ''}`);
      el.style.transform = `translate(${m.x.toFixed(0)}px, ${m.y.toFixed(0)}px)`;
      setText((el.querySelector('b') as HTMLElement), m.letter);
      setText((el.querySelector('span') as HTMLElement), m.here ? '' : `${Math.round(m.dist)}m`);
    });
    const cb = this.hud.querySelector('.capbar') as HTMLElement;
    if (!cap && (cb as any)._cv !== 'capbar hidden') setCls(cb, 'capbar hidden');
    if (cap) {
      setCls(cb, `capbar ${cap.rel}`);
      setText((cb.querySelector('.cl') as HTMLElement), cap.letter);
      setText((cb.querySelector('.ct') as HTMLElement), cap.text);
      (cb.querySelector('.cb i') as HTMLElement).style.width = `${(cap.progress * 100).toFixed(1)}%`;
    }
  }

  /** Killstreak column (bottom right, above the ammo): ready streaks glow, with their key. */
  updateStreaks(list: { name: string; key: string; kills: number; ready: boolean; active: boolean }[], streak: number) {
    const el = this.hud.querySelector('.streaks') as HTMLElement;
    const key = list.map((s) => `${s.ready}${s.active}`).join() + streak;
    if (el.dataset.k === key) return;
    el.dataset.k = key;
    el.innerHTML = list
      .map((s) => `<div class="sk ${s.ready ? 'ready' : ''} ${s.active ? 'active' : ''}"><em>${s.ready ? `[${s.key}]` : `${Math.min(streak, s.kills)}/${s.kills}`}</em><b>${s.name}</b>${icon(s.name === 'UAV' ? 'uav' : s.name.startsWith('MORTAR') ? 'mortar' : 'heli')}</div>`)
      .join('');
  }

  /** Lethal / tactical slots next to the ammo: icon, count, key; frag cook timer. */
  updateNades(frags: number, cooking: number, tac: TacticalId = this.tactical, tacN = 0, lethal: LethalId = this.lethal, field = 0, c4Out = 0) {
    const el = this.hud.querySelector('.nades') as HTMLElement;
    const key = `${frags}|${cooking > 0 ? Math.ceil(cooking * 10) : 0}|${tac}|${tacN}|${lethal}|${Math.floor(field * 40)}|${c4Out}`;
    if (el.dataset.k === key) return;
    el.dataset.k = key;
    const slot = (name: string, n: number, k: string) => `<div class="eqs ${n ? '' : 'empty'}">${icon(name)}<b>${n}</b><em>${k}</em></div>`;
    // field upgrade: a charge ring that fills, glowing with its key when ready
    const ready = field >= 1;
    const ring = `<div class="eqs fu ${ready ? 'ready' : 'empty'}" style="--fu:${Math.min(1, field) * 360}deg">${icon('trophy')}<b>${ready ? '' : Math.floor(field * 100) + '%'}</b><em>H</em></div>`;
    const det = c4Out > 0 ? `<div class="det">${frags > 0 ? '[F][F]' : '[G]'} DETONATE · ${c4Out}</div>` : '';
    el.innerHTML = slot(lethal, frags, 'G') + slot(tac, tacN, 'T') + ring + det + (cooking > 0 ? `<div class="cook"><i style="width:${(cooking / 3.5) * 100}%"></i><b>${cooking.toFixed(1)}</b></div>` : '');
  }

  /** Status effects: stim boost timer, stunned / blinded labels. */
  updateStatus(stim: number, stun: number, blind: number) {
    let el = this.hud.querySelector('.status') as HTMLElement | null;
    if (!el) {
      el = h('div', 'status');
      this.hud.appendChild(el);
    }
    const key = `${Math.ceil(stim * 4)}|${stun > 0}|${blind > 0}`;
    if (el.dataset.k === key) return;
    el.dataset.k = key;
    el.innerHTML = (stim > 0 ? `<div class="st stim">${icon('stim')}<span>STIM</span><div class="sb"><i style="width:${(stim / 10) * 100}%"></i></div></div>` : '')
      + (stun > 0 ? `<div class="st stun">${icon('stun')}<span>STUNNED</span></div>` : '')
      + (blind > 0 ? `<div class="st blind">${icon('flash')}<span>BLINDED</span></div>` : '');
  }

  /** Mortar designation prompt. */
  designatorHint(v: boolean, dist: number, tooClose: boolean) {
    let el = this.hud.querySelector('.designate') as HTMLElement | null;
    if (!el) {
      el = h('div', 'designate hidden');
      this.hud.appendChild(el);
    }
    el.classList.toggle('hidden', !v);
    if (v) setHTML(el, `${icon('mortar')}<b class="${tooClose ? 'warn' : ''}">${tooClose ? 'TOO CLOSE' : `TARGET ${dist} m`}</b><span>[LMB] CALL MORTAR STRIKE · [RMB / 4] CANCEL</span>`);
  }


  /** Big centred announcement (flag captured / lost, killstreak inbound). */
  announce(text: string, sub = '', cls = '') {
    let el = this.hud.querySelector('.announce') as HTMLElement | null;
    if (!el) {
      el = h('div', 'announce');
      this.hud.appendChild(el);
    }
    el.className = `announce ${cls}`;
    el.innerHTML = `<b>${text}</b>${sub ? `<span>${sub}</span>` : ''}`;
    void el.offsetWidth;
    el.classList.add('on');
    clearTimeout((el as any)._t);
    (el as any)._t = window.setTimeout(() => el!.classList.remove('on'), 2200);
  }

  /** Killcam overlay: letterbox, title, who killed you with what, and a progress line. */
  showKillcam(v: boolean, killer = '', weapon = '') {
    let el = this.root.querySelector('.killcam') as HTMLElement | null;
    if (!el) {
      el = h('div', 'killcam hidden', `<div class="lb kc-top"><b>KILLCAM</b></div><div class="lb kc-bot"><div class="kk"></div><div class="kp"><i></i></div><div class="ks">[SPACE] SKIP</div></div>`);
      this.root.appendChild(el);
    }
    el.classList.toggle('hidden', !v);
    if (v) setHTML((el.querySelector('.kk') as HTMLElement), `<span class="red">${killer}</span> <em>${weapon}</em>`);
  }
  setKillcamProgress(p: number) {
    const i = this.root.querySelector('.killcam .kp i') as HTMLElement | null;
    if (i) i.style.width = `${Math.min(100, Math.max(0, p * 100)).toFixed(1)}%`;
  }

  /** Subtitles for voice callouts: speaker name (coloured by side) and what they said. */
  subtitle(who: string, text: string, side: 'f' | 'e' | 'me' | 'hq' | 'radio', dist: number, hold = 2.8) {
    let el = this.hud.querySelector('.subs') as HTMLElement | null;
    if (!el) {
      el = h('div', 'subs');
      this.hud.appendChild(el);
    }
    const line = h('div', `subline ${side}`, `<b>${who}</b>${side === 'e' ? '<em>ENEMY</em>' : ''}<span>${text}</span>${dist > 8 ? `<i>${Math.round(dist)} m</i>` : ''}`);
    el.appendChild(line);
    while (el.children.length > 3) el.firstChild!.remove();
    setTimeout(() => line.classList.add('out'), Math.max(2800, hold * 1000));
    setTimeout(() => line.remove(), Math.max(2800, hold * 1000) + 500);
  }

  private nvgShown = false;
  /** Night: "[N] NIGHT VISION" prompt (with goggles icon) until the goggles are down. */
  nvgPrompt(show: boolean) {
    if (show === this.nvgShown) return;
    this.nvgShown = show;
    let el = this.hud.querySelector('.nvgprompt') as HTMLElement | null;
    if (!el) {
      el = h('div', 'nvgprompt', `<svg viewBox="0 0 48 24" width="38" height="19"><path d="M6 6h36a4 4 0 0 1 4 4v6a6 6 0 0 1-6 6h-6a6 6 0 0 1-6-5h-4a6 6 0 0 1-6 5H8a6 6 0 0 1-6-6v-6a4 4 0 0 1 4-4z" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="13" cy="15" r="3.2" fill="currentColor"/><circle cx="35" cy="15" r="3.2" fill="currentColor"/><path d="M20 6V2h8v4" fill="none" stroke="currentColor" stroke-width="2.4"/></svg><span><b>N</b> NIGHT VISION</span>`);
      this.hud.appendChild(el);
    }
    el.classList.toggle('on', show);
  }

  private hintText = '';
  /** Context prompt under the crosshair ([E] OPEN DOOR ...). */
  interactHint(text: string) {
    if (text === this.hintText) return;
    this.hintText = text;
    let el = this.hud.querySelector('.ihint') as HTMLElement | null;
    if (!el) {
      el = h('div', 'ihint');
      this.hud.appendChild(el);
    }
    el.textContent = text;
    el.classList.toggle('on', !!text);
  }

  /** Grenade danger icons around the crosshair, pointing at nearby live grenades. */
  grenadeWarn(angles: number[]) {
    let el = this.hud.querySelector('.nadewarn') as HTMLElement | null;
    if (!el) {
      el = h('div', 'nadewarn');
      this.hud.appendChild(el);
    }
    while (el.children.length < angles.length) el.appendChild(h('i', '', '<b></b>'));
    Array.from(el.children).forEach((c, i) => {
      const e = c as HTMLElement;
      e.style.display = i < angles.length ? '' : 'none';
      if (i < angles.length) e.style.transform = `rotate(${angles[i]}rad) translateY(-120px)`;
    });
  }

  damageFrom(angle: number) {
    const i = h('i');
    i.dataset.life = '1.6';
    i.style.transform = `rotate(${angle}rad)`;
    this.dmgEl.appendChild(i);
  }

  notify(text: string, sub = '', cls = '') {
    const n = h('div', `note ${cls}`, `<b>${text}</b>${sub ? `<span>${sub}</span>` : ''}`);
    this.notifyEl.prepend(n);
    while (this.notifyEl.children.length > 3) this.notifyEl.lastChild!.remove();
    setTimeout(() => n.classList.add('out'), 1800);
    setTimeout(() => n.remove(), 2400);
  }

  updateFeed(feed: KillEvent[], now: number) {
    const key = feed.map((f) => f.t).join(',');
    if (key === this.lastFeedKey) {
      this.feedEl.querySelectorAll('.k').forEach((el) => {
        const t = parseFloat((el as HTMLElement).dataset.t!);
        (el as HTMLElement).style.opacity = String(Math.max(0, Math.min(1, 7 - (now - t))));
      });
      return;
    }
    this.lastFeedKey = key;
    this.feedEl.innerHTML = feed
      .map((f) => `<div class="k" data-t="${f.t}"><span class="${f.killerTeam === 0 ? 'blue' : 'red'}">${f.killer}</span><em>${f.weapon}${f.headshot ? ' <i class="hs">✛</i>' : ''}${f.wallbang ? ' <i class="wb">▤</i>' : ''}</em><span class="${f.victimTeam === 0 ? 'blue' : 'red'}">${f.victim}</span></div>`)
      .join('');
  }

  private deathKey = '';
  showDeath(v: boolean, killer = '', weapon = '', t = 0) {
    this.deathEl.classList.toggle('hidden', !v);
    if (!v) {
      this.deathKey = '';
      return;
    }
    const key = `${killer}|${weapon}|${Math.ceil(t)}|${this.activePreset}`;
    if (key === this.deathKey) return;
    this.deathKey = key;
    const cards = this.presets.map((p, i) => `<div class="dlo ${i === this.activePreset ? 'on' : ''}"><b>${i + 1}</b><span>${p.name}</span><small>${WEAPONS[p.p]?.short ?? ''} · ${WEAPONS[p.s]?.short ?? ''}</small></div>`).join('');
    setHTML(this.deathEl, `<div class="kb">ELIMINATED BY</div><div class="kn">${killer}</div><div class="kw">${weapon}</div><div class="rs">Redeploying in ${Math.ceil(t)}…</div><div class="dloadouts">${cards}</div><div class="dlhint">1–5: loadout for your next life</div>`);
  }
}
