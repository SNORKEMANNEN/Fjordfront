import { Settings, SettingsData, Quality } from '../game/Settings';
import { ACTION_LABELS, keysFor, keyLabel, applyKeybinds, Action } from '../core/Input';
import { loadIce, saveIce, testIce } from '../net/Net';
import { WEAPONS, PRIMARIES, SECONDARIES, WeaponDef } from '../weapons/WeaponDefs';
import type { WeaponPreview } from './WeaponPreview';
import { icon, emblem } from './Icons';
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
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

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
/** something on the compass ribbon: bearing in degrees (0 = north) */
export interface CompassMark { bearing: number; kind: 'flag' | 'ping' | 'wp' | 'foe'; label?: string; rel?: 'f' | 'e' | 'n' }
/** scoreboard row (match snapshot + what the scoreboard shows) */
export interface ScoreRow extends CombatantState { role?: string; assists?: number; captures?: number; bot?: boolean }

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
/** calibre stamped on the workbench callouts */
const CALIBRE: Record<string, string> = {
  k416: '5.56×45 mm', ks17: '5.56×45 mm', hval47: '7.62×39 mm', kr98: '7.92×57 mm', lmg: '5.56×45 mm · belt', stille9: '9×19 mm', ums45: '.45 ACP',
  mp7: '4.6×30 mm', pump12: '12 gauge', as20: '12 gauge', db12: '12 gauge', skv338: '.338 Lapua Mag.', dmr14: '7.62×51 mm', p80: '9×19 mm', mp18: '9×19 mm', rv357: '.357 Magnum', knife: '—',
};

export interface UIHandlers {
  onPlay(): void;
  onMultiplayer?(): void;
  onQuickPlay?(): void;
  onResume(): void;
  onQuit(): void;
  onRestart(): void;
  onLoadout(): void;
  onSettings(): void;
  /** scoreboard row actions (multiplayer) */
  onMute?(id: number): void;
  onReport?(id: number): void;
}

/** loading-screen lines: the map's own lore, then controls */
const TIPS: [string, string][] = [
  ['FRA KARTET · FROM THE CHART', "Kvitvika's harbour freezes over for only a few days each winter — the Gulf Stream keeps the fjord open."],
  ['FRA KARTET · FROM THE CHART', 'Kystfortet was cut into the headland in 1942. Its guns still point at the fjord mouth; its tunnels still connect the batteries.'],
  ['FRA KARTET · FROM THE CHART', 'The rorbuer on Brygga were fishermen\'s cabins for the winter cod season. Every one has a back door onto the quay.'],
  ['FRA KARTET · FROM THE CHART', 'Hjellene — the drying racks — hang stockfish from February to June. Their timber frames stop nothing, but they hide everything.'],
  ['FRA KARTET · FROM THE CHART', 'The road tunnel under Ryggen has two emergency exits on each side, and hatches up to the ridge.'],
  ['FRA KARTET · FROM THE CHART', 'Fyret, the lighthouse, has guided boats past the skerries at the fjord mouth since 1894.'],
  ['KONTROLLER · CONTROLS', 'Double-tap SHIFT for tactical sprint. Crouch while sprinting to slide; jump out of it to keep the speed.'],
  ['KONTROLLER · CONTROLS', 'Hold Q / E to lean round corners. Aim at a closed door to ease it open a crack and peek.'],
  ['KONTROLLER · CONTROLS', 'N flips the night-vision goggles down. At night they are the difference between seeing and guessing.'],
  ['KONTROLLER · CONTROLS', 'Hold Y and flick the mouse to order your squad: attack, defend, follow, hold.'],
  ['KONTROLLER · CONTROLS', 'Hold V for the combat knife. Throwing knives kill in one hit — walk over them to pick them up.'],
  ['KONTROLLER · CONTROLS', 'M opens the chart: scroll to zoom, right-click for a waypoint, left-click to ping.'],
];

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
  private popEl!: HTMLElement;
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
  sbExtra: ((id: number) => { ping: string; talk: boolean; muted?: boolean } | null) | null = null;
  /** weapon name → white silhouette (data URL) rendered from the game's own 3D models */
  weaponIcon: ((name: string) => string | null) | null = null;
  /** play an interface sound (wired to the audio engine's 'ui' bus by the game) */
  sfx: (name: 'uiHover' | 'uiConfirm' | 'uiBack' | 'uiReady' | 'uiHorn', gain?: number) => void = () => {};
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
    this.wireSounds();
  }

  /** interface sounds by delegation: a soft tick when the pointer reaches something clickable, a
   *  confirm on press (a falling "back" on back / close buttons) */
  private wireSounds() {
    const CLICKABLE = 'button, .mode, .ldcard, .room, .kit, .dlo, [data-human]';
    let lastHover: Element | null = null;
    let lastT = 0;
    this.root.addEventListener('pointerover', (e) => {
      const t = (e.target as Element).closest?.(CLICKABLE);
      if (!t || t === lastHover) return;
      lastHover = t;
      const now = performance.now();
      if (now - lastT < 45) return;
      lastT = now;
      this.sfx('uiHover', 0.5);
    });
    this.root.addEventListener('pointerout', (e) => {
      if ((e.target as Element).closest?.(CLICKABLE) === lastHover) lastHover = null;
    });
    this.root.addEventListener('click', (e) => {
      const t = (e.target as Element).closest?.(CLICKABLE) as HTMLElement | null;
      if (!t) return;
      const a = t.dataset?.a ?? '';
      if (a === 'back' || a === 'menu' || a === 'quit' || a === 'resume' || t.classList.contains('back')) this.sfx('uiBack', 0.6);
      else this.sfx('uiConfirm', t.classList.contains('primary') || t.classList.contains('mode') ? 0.75 : 0.45);
    }, true);
  }

  // ---------------------------------------------------------------- loading: a boat crossing the fjord
  private buildLoading() {
    // adopt the loading screen index.html already painted (no blank frame between page and game)
    const pre = document.getElementById('boot');
    if (pre) {
      pre.classList.add('screen', 'loading');
      return pre;
    }
    return h('div', 'screen loading', `<div class="row"><span class="pct">0%</span><span class="bstatus">Loading</span></div><div class="tip"><small></small><span></span></div>`);
  }

  private loadP = 0;
  private tipI = 0;
  private tipT = 0;
  private courseLen = 0;
  /** progress never moves backwards; the boat sails the course as the game loads */
  private loadDrawT = 0;
  setLoading(p: number, status: string) {
    this.loadP = Math.max(this.loadP, Math.min(1, p));
    const pct = Math.round(this.loadP * 100);
    const L = this.loading;
    // (at most ~6 visual updates a second: shader warm-up calls this between every program)
    const tnow = performance.now();
    if (this.loadP < 1 && tnow - this.loadDrawT < 160) return;
    this.loadDrawT = tnow;
    const course = L.querySelector('#course') as SVGPathElement | null;
    if (course) {
      if (!this.courseLen) this.courseLen = course.getTotalLength();
      const len = this.courseLen;
      const at = len * this.loadP;
      (L.querySelector('.done') as SVGPathElement).setAttribute('stroke-dasharray', `${at.toFixed(1)} ${len + 10}`);
      const a = course.getPointAtLength(at), b = course.getPointAtLength(Math.min(len, at + 4));
      const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      (L.querySelector('.boat') as SVGGElement).setAttribute('transform', `translate(${a.x.toFixed(1)} ${a.y.toFixed(1)}) rotate(${(ang * 0.6).toFixed(1)})`);
    }
    setText(L.querySelector('.bstatus'), status);
    setText(L.querySelector('.pct'), `${pct}%`);
    const now = performance.now();
    if (now - this.tipT > 4200) {
      this.tipT = now;
      const tip = L.querySelector('.tip') as HTMLElement | null;
      if (tip && this.tipI++ > 0) {
        const [k, v] = TIPS[(this.tipI + Math.floor(Math.random() * 3)) % TIPS.length];
        tip.innerHTML = `<small>${k}</small><span>${v}</span>`;
      }
    }
  }
  hideLoading() {
    this.setLoading(1, 'Ready');
    this.loading.classList.add('fade');
    setTimeout(() => this.loading.classList.add('hidden'), 600);
  }

  // ---------------------------------------------------------------- main menu
  private menuTab: 'play' | 'manual' = 'play';
  private buildMenu() {
    const e = h('div', 'screen menu hidden', `
      <nav class="rail">
        <div class="mark">${icon('anchor')}</div>
        <button class="tab on" data-tab="play">${icon('play')}<span>PLAY</span></button>
        <button class="tab" data-tab="loadout">${icon('loadout')}<span>LOADOUT</span></button>
        <button class="tab" data-tab="settings">${icon('settings')}<span>SETTINGS</span></button>
        <button class="tab" data-tab="manual">${icon('manual')}<span>MANUAL</span></button>
        <div class="grow"></div>
        <div class="ver">KART<br>NR. 29</div>
      </nav>
      <div class="menu-body">
        <div class="brand"><div class="wordmark">FJORDFRONT</div><div class="tagline"><i></i>DOMINATION · KVITVIKA, NORDLAND</div></div>
        <div class="pane"></div>
        <div class="side">
          <div class="news paper-card"><div class="nh"><b>MELDINGER</b><span class="eyebrow">NEWS · PATCH NOTES</span></div><div class="nl"><div class="ni"><div class="serif-note">Reading the logbook…</div></div></div></div>
          <div class="brief paper-card">
            <div class="bh"><b>OPERASJONSORDRE</b><span class="eyebrow red">OPERATION BRIEF</span></div>
            <div class="chart"><div class="loadingc">Drawing the chart…</div></div>
            <div class="facts"><div><small>VIND</small><span class="f-wind">—</span></div><div><small>SJØ</small><span class="f-sea">—</span></div><div><small>KL.</small><span class="f-time">—</span></div><div><small>SESONG</small><span class="f-season">—</span></div></div>
            <p>Hostile forces of <b class="red">NORDFRONT</b> hold the old coastal fort above Kvitvika. Push from the harbour with the <b class="blue">KYSTJEGERNE</b>, take three objectives and hold the fjord.</p>
            <div class="sides"><div class="sd k">${emblem(0)}KYSTJEGERNE</div><span class="vs">mot</span><div class="sd n">NORDFRONT${emblem(1)}</div></div>
          </div>
        </div>
        <div class="credits">Chart fonts: Big Shoulders Display · IBM Plex (SIL OFL) · Firearm recordings: Free Firearm Sound Library (CC0) · Voices &amp; effects: ElevenLabs · Music: Stable Audio 2.5 (Stability AI) · FPS arms by DJMaesen (CC BY 4.0) · Kenney Impact Sounds (CC0) · Procedural soldiers, icons &amp; emblems · Water normals: three.js</div>
      </div>
      <div class="soldier-tag paper-card hidden"></div>`);
    e.querySelectorAll('.rail .tab').forEach((b) =>
      b.addEventListener('click', () => {
        const t = (b as HTMLElement).dataset.tab!;
        if (t === 'loadout') return this.showLoadout('menu');
        if (t === 'settings') return this.showSettings('menu');
        this.menuTab = t as 'play' | 'manual';
        e.querySelectorAll('.rail .tab').forEach((x) => x.classList.toggle('on', x === b));
        this.renderPane();
      }),
    );
    this.menu = e;
    this.renderPane();
    this.loadNews();
    return e;
  }

  /** the left pane: mode cards + the current kit, or the field manual */
  private renderPane() {
    const pane = this.menu.querySelector('.pane') as HTMLElement;
    if (this.menuTab === 'manual') {
      const rows: [string, string][] = [
        ['W A S D', 'Move'], ['MOUSE', 'Look · fire · aim'], ['SHIFT', 'Sprint · again: tactical sprint'], ['C / CTRL', 'Crouch · sprinting: slide'],
        ['Z', 'Prone · sprinting: dive'], ['SPACE', 'Jump · mantle · vault'], ['R', 'Reload'], ['1 / 2', 'Switch weapon'],
        ['Q / E', 'Lean (hold)'], ['B', 'Fire mode'], ['I', 'Inspect · hold: mag check'], ['F', 'Use · door · zipline · spot'],
        ['G', 'Lethal (hold: cook / aim)'], ['T', 'Tactical'], ['H', 'Field upgrade'], ['V', 'Melee · hold: knife'],
        ['3 4 5', 'Killstreaks'], ['N', 'Night vision'], ['X', 'Ping'], ['M', 'Chart (tactical map)'],
        ['Y', 'Squad orders (hold)'], ['TAB', 'Scoreboard · RMB: cursor'], ['ENTER / U', 'Chat · team chat'], ['K', 'Push to talk'],
        ['F6', 'Spectate / free camera'], ['F3', 'Performance overlay'], ['ESC', 'Pause · loadout · settings'], ['1–5 (dead)', 'Loadout for next life'],
      ];
      pane.innerHTML = `<div class="ptitle">FELTHÅNDBOK<small>FIELD MANUAL · ALL KEYS CAN BE REBOUND IN SETTINGS</small></div>
        <div class="manual paper-card"><div class="mg">${rows.map(([k, v]) => `<div><b>${k}</b>${v}</div>`).join('')}</div></div>`;
      return;
    }
    pane.innerHTML = `<div class="ptitle">VELG OPPDRAG<small>CHOOSE A MISSION</small></div>
      <div class="modes">
        <button class="mode paper-card hot" data-mode="dom"><span class="mi">${icon('domination')}</span><span><b>Domination</b><span>12 v 12 against AI squads. Take and hold three flags.</span></span><em>SOLO</em></button>
        <button class="mode paper-card" data-mode="mp"><span class="mi">${icon('multiplayer')}</span><span><b>Multiplayer</b><span>Host a room, join with a code or browse public rooms. Bots fill the empty slots.</span></span><em>ONLINE</em></button>
        <button class="mode paper-card" data-mode="quick"><span class="mi">${icon('quick')}</span><span><b>Quick Play</b><span>Straight into the fullest public room — or open one if there is none.</span></span><em>ONLINE</em></button>
      </div>
      <div class="kit paper-card" data-a="kit"><span class="eyebrow red">KIT · <span class="kit-preset"></span></span><div class="kn"></div><div class="ks"></div></div>`;
    pane.querySelector('[data-mode=dom]')!.addEventListener('click', () => this.handlers.onPlay());
    pane.querySelector('[data-mode=mp]')!.addEventListener('click', () => this.handlers.onMultiplayer?.());
    pane.querySelector('[data-mode=quick]')!.addEventListener('click', () => this.handlers.onQuickPlay?.());
    pane.querySelector('.kit')!.addEventListener('click', () => this.showLoadout('menu'));
    this.updateMenuWeapon();
  }

  /** README "Update N" sections → the news panel (loaded lazily, outside the boot path) */
  private async loadNews() {
    try {
      const md: string = (await import('../../README.md?raw')).default;
      const items: { n: string; title: string; bullets: string[] }[] = [];
      const re = /^## Update (\d+)(?::\s*(.*))?$/gm;
      const heads: { n: string; title: string; at: number; end: number }[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(md))) heads.push({ n: m[1], title: m[2] || '', at: m.index + m[0].length, end: md.length });
      heads.forEach((hd, i) => (hd.end = i + 1 < heads.length ? heads[i + 1].at : md.indexOf('\n## ', hd.at) > 0 ? md.indexOf('\n## ', hd.at) : md.length));
      heads.sort((a, b) => +b.n - +a.n);
      for (const hd of heads.slice(0, 8)) {
        const body = md.slice(hd.at, hd.end);
        // the update's own section headings make the best summary; else its first bullets
        const subs = [...body.matchAll(/^### (.+)$/gm)].map((b) => b[1]).filter((t) => !/^(tested|not yet|known)/i.test(t));
        const bullets = (subs.length ? subs : [...body.matchAll(/^- (?:\*\*(.+?)\*\*[:.]?\s*)?(.*)$/gm)].map((b) => (b[1] ? b[1] : b[2])))
          .slice(0, 5)
          .map((b) => b.replace(/\*\*|`/g, '').replace(/\[(.+?)\]\(.+?\)/g, '$1').replace(/\s*\(`?src\/.*?\)$/, '').slice(0, 110));
        items.push({ n: hd.n, title: hd.title.replace(/\*\*|`/g, ''), bullets });
      }
      const nl = this.menu.querySelector('.news .nl') as HTMLElement;
      nl.innerHTML = items.map((it, i) => `<div class="ni ${i === 0 ? 'new' : ''}"><div class="nt"><em>OPPD. ${it.n}</em><b>${esc(it.title || 'Update ' + it.n)}</b></div>${it.bullets.length ? `<ul>${it.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}</div>`).join('');
    } catch {
      /* no news is good news */
    }
  }

  /** operation brief: the chart (built by the game from the terrain) and the conditions */
  setBrief(chart: HTMLCanvasElement | null, facts: { wind: string; sea: string; time: string; season: string }) {
    const b = this.menu.querySelector('.brief') as HTMLElement;
    if (chart) {
      const box = b.querySelector('.chart') as HTMLElement;
      box.innerHTML = '';
      box.appendChild(chart);
    }
    setText(b.querySelector('.f-wind'), facts.wind);
    setText(b.querySelector('.f-sea'), facts.sea);
    setText(b.querySelector('.f-time'), facts.time);
    setText(b.querySelector('.f-season'), facts.season);
  }

  /** the 3D menu soldier's name tag (screen position from the game; null hides it) */
  soldierTag(pos: { x: number; y: number } | null, team: 0 | 1) {
    const t = this.menu.querySelector('.soldier-tag') as HTMLElement;
    if (!pos || this.menuTab !== 'play') {
      t.classList.add('hidden');
      return;
    }
    t.classList.remove('hidden');
    const name = (localStorage.getItem('ff.name') || 'Soldat').toUpperCase();
    const p = this.presets[this.activePreset];
    const html = `${emblem(team)}<span><b>${esc(name)}</b><small>${team === 0 ? 'KYSTJEGERNE' : 'NORDFRONT'} · ${esc(p?.name ?? '')}</small></span>`;
    setHTML(t, html);
    setCls(t, `soldier-tag paper-card ${team === 0 ? 'k' : 'n'}`);
    // keep it in the middle column, clear of the mode cards and the news / brief cards
    const side = this.menu.querySelector('.side')?.getBoundingClientRect();
    const pane = this.menu.querySelector('.pane')?.getBoundingClientRect();
    const half = (t.offsetWidth || 200) / 2;
    const x = Math.max((pane?.right ?? 0) + half + 12, Math.min((side?.left ?? window.innerWidth) - half - 12, pos.x));
    t.style.left = `${x.toFixed(0)}px`;
    t.style.top = `${Math.max(150, pos.y).toFixed(0)}px`;
  }

  private updateMenuWeapon(e = this.menu) {
    const p = this.presets[this.activePreset];
    setText(e.querySelector('.kit-preset'), p?.name ?? '');
    setText(e.querySelector('.kit .kn'), `${WEAPONS[this.primary].short} · ${WEAPONS[this.secondary].short}`);
    setText(e.querySelector('.kit .ks'), `${(LETHALS.find((l) => l.id === this.lethal)?.name ?? '').toLowerCase()} · ${TACTICALS.find((t) => t.id === this.tactical)!.name.toLowerCase()}`);
    // the silhouette is rendered on first use: after the menu has painted, not in its way
    const name = WEAPONS[this.primary].name;
    setTimeout(() => {
      const kit = e.querySelector('.kit') as HTMLElement | null;
      const url = kit ? this.weaponIcon?.(name) : null;
      if (!kit || !url) return;
      let img = kit.querySelector('img');
      if (!img) {
        img = document.createElement('img');
        img.alt = '';
        kit.appendChild(img);
      }
      if (img.src !== url) img.src = url;
    }, 120);
    this.onKitChange?.();
  }
  /** the game re-dresses the menu soldier when the kit changes */
  onKitChange: (() => void) | null = null;

  showMenu(v: boolean) {
    this.menu.classList.toggle('hidden', !v);
    if (v) this.updateMenuWeapon();
  }
  get menuVisible() {
    return !this.menu.classList.contains('hidden') && this.settingsEl.classList.contains('hidden') && this.loadoutEl.classList.contains('hidden');
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
  private ldSlot: 'p' | 's' | 't' | 'l' | 'f' = 'p';
  private ldShown: WeaponId | null = null;
  private ldHover: WeaponId | null = null;
  private ldMode: 'overview' | 'pick' = 'overview';
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

  /**
   * Loadout screen. Layout: header bar (back · title · confirm), the workbench preview filling the
   * upper area, a horizontal overview strip of the selected loadout (primary · secondary · tactical ·
   * lethal · perks · field upgrade) near the bottom, and the five saved loadouts in a row beneath it.
   * Clicking a section turns the strip into that slot's picker (categories + cards) and puts the
   * stats / comparison column beside the bench; BACK returns to the overview.
   */
  showLoadout(back: 'menu' | 'pause' = 'menu', note = '') {
    this.loadoutBack = back;
    this.ldMode = 'overview';
    this.ldShown = null;
    this.ldHover = null;
    const e = this.loadoutEl;
    const CATS: { cls: WeaponDef['cls']; label: string }[] = [
      { cls: 'Assault Rifle', label: 'ASSAULT RIFLES' }, { cls: 'SMG', label: 'SMGS' }, { cls: 'LMG', label: 'LMGS' }, { cls: 'Shotgun', label: 'SHOTGUNS' },
      { cls: 'Marksman', label: 'MARKSMAN RIFLES' }, { cls: 'Sniper', label: 'SNIPER RIFLES' }, { cls: 'Pistol', label: 'HANDGUNS' },
    ];
    const CLS_NAME: Record<string, string> = { LMG: 'LIGHT MACHINE GUN', 'Assault Rifle': 'ASSAULT RIFLE', SMG: 'SUBMACHINE GUN', Shotgun: 'SHOTGUN', Marksman: 'MARKSMAN RIFLE', Sniper: 'SNIPER RIFLE', Pistol: 'HANDGUN' };
    const SLOT_NAME: Record<string, string> = { p: 'PRIMARY WEAPON', s: 'SIDEARM', t: 'TACTICAL', l: 'LETHAL', f: 'FIELD UPGRADE' };
    const TROPHY_DESC = 'Press H to deploy. Shoots down up to 3 enemy grenades, C4, sticky grenades and throwing knives within 7.5 m. Recharges over time.';
    const stats = (d: WeaponDef): [string, number][] => [
      ['Damage', (d.damage[0] * d.pellets) / 110],
      ['Fire Rate', d.rpm / 950],
      ['Range', d.range[1] / 300],
      ['Accuracy', 1 - Math.min(1, (d.hipSpread * 0.06 + d.adsSpread * 0.8 + d.bloomMax * 0.05))],
      ['Recoil Control', 1 - Math.min(1, d.recoil.v / 6)],
      ['Mobility', Math.min(1, d.speedMul * 0.75 + d.adsSpeedMul * 0.25)],
      ['Handling', 1 - Math.min(1, d.adsTime / 0.45) * 0.85],
    ];
    const thumb = (id: WeaponId) => (this.preview ? `<img alt="" src="${this.preview.thumbnail(id)}">` : '');
    const save = () => {
      Object.assign(this.presets[this.activePreset], { p: this.primary, s: this.secondary, l: this.lethal, t: this.tactical });
      this.savePresets();
    };
    /** the workbench: the gun, blueprint grid, technical-drawing callouts, drawing plate */
    const bench = (d: WeaponDef) => `<div class="ldview">
        <svg class="callouts" viewBox="0 0 1000 600" preserveAspectRatio="none">
          <path d="M120 150H230L300 262"/><circle cx="300" cy="262" r="5"/>
          <path d="M880 150H760L640 262"/><circle cx="640" cy="262" r="5"/>
          <path d="M560 520H600L560 380"/><circle cx="560" cy="380" r="5"/>
          <path class="dim" d="M160 470H840M160 455V485M840 455V485"/>
        </svg>
        <div class="co" style="left:4%;top:13%"><small>KALIBER · CALIBRE</small><b>${CALIBRE[d.id] ?? '—'}</b></div>
        <div class="co" style="right:4%;top:13%;text-align:right"><small>KADENS · RATE</small><b>${d.rpm} RPM</b></div>
        <div class="co" style="left:61%;top:82%"><small>MAGASIN · MAGAZINE</small><b>${d.mag} + ${d.reserve}</b></div>
        <div class="co" style="left:16%;top:80%"><small>EFFEKTIV RANGE</small><b>${d.range[0]}–${d.range[1]} m</b></div>
        <div class="plate"><b>${d.short}</b>TEGNING NR. ${String(PRIMARIES.concat(SECONDARIES).indexOf(d.id as WeaponId) + 1).padStart(2, '0')} · ${CLS_NAME[d.cls]}</div>
      </div>`;
    /** the stats column (pick mode): equipped value, green / red delta against it when inspecting another gun */
    const info = (d: WeaponDef, eqd: WeaponDef) => {
      const cmp = d.id !== eqd.id;
      const statRow = ([k, v]: [string, number], i: number) => {
        const nv = Math.max(0.04, Math.min(1, v)), ov = Math.max(0.04, Math.min(1, stats(eqd)[i][1]));
        const dlt = Math.round((nv - ov) * 100);
        const lo = Math.min(nv, ov), hi = Math.max(nv, ov);
        return `<div class="ldst"><span>${k}</span><b><i style="width:${Math.round(lo * 100)}%"></i>${cmp && dlt ? `<s class="${dlt < 0 ? 'neg' : ''}" style="left:${Math.round(lo * 100)}%;width:${Math.round((hi - lo) * 100)}%"></s>` : ''}</b><em class="${cmp && dlt > 0 ? 'up' : cmp && dlt < 0 ? 'down' : ''}">${cmp && dlt ? (dlt > 0 ? '+' : '−') + Math.abs(dlt) : Math.round(nv * 100)}</em></div>`;
      };
      return `<div class="ldinfo"><div class="ldcls">${CLS_NAME[d.cls]}</div><div class="ldname">${d.name.toUpperCase()}</div><p>${d.desc}</p>
        <div class="ldstats">${stats(d).map(statRow).join('')}</div>
        ${cmp ? `<div class="hint">Compared with your equipped ${eqd.short}: <span style="color:var(--green)">green</span> is better, <span style="color:var(--red)">red</span> worse.</div>` : ''}
        <div class="ldnums"><div><small>ROUNDS</small>${d.mag}</div><div><small>RESERVE</small>${d.reserve}</div><div><small>RPM</small>${d.rpm}</div><div><small>DAMAGE</small>${d.damage[0]}${d.pellets > 1 ? `×${d.pellets}` : ''}</div></div>
      </div>`;
    };
    /** equipment details beside the bench (pick mode for tactical / lethal / field upgrade) */
    const eqInfo = (id: string, kind: string, name: string, desc: string, count: number) => `<div class="ldinfo"><div class="ldcls">${kind}</div><div class="ldname">${name}</div><p>${desc}</p>
        <div class="ldnums"><div><small>PER LIFE</small>×${count}</div><div><small>KEY</small>${kind === 'TACTICAL' ? 'T' : kind === 'LETHAL' ? 'G' : 'H'}</div></div></div>`;

    const render = () => {
      const mode = this.ldMode;
      const slot = this.ldSlot;
      const lethal = LETHALS.find((l) => l.id === this.lethal)!, tac = TACTICALS.find((t) => t.id === this.tactical)!;
      const preset = this.presets[this.activePreset];
      // ---- header bar
      const head = `<div class="ldhead">
          <button class="back ldback" data-a="${mode === 'pick' ? 'overview' : 'done'}">${icon('chevron')}</button>
          <div class="ldtitle">${mode === 'pick' ? SLOT_NAME[slot] : 'REDIGER UTRUSTNING'} <small>${mode === 'pick' ? `${esc(preset.name)} · ${back === 'pause' ? 'applies on your next spawn' : 'choose and equip'}` : `edit loadouts · ${back === 'pause' ? 'changes apply on your next spawn' : 'choose your kit'}`}</small></div>
          ${note ? `<div class="lnote">${note}</div>` : ''}
          <div class="ldheadr"><span class="ldhint">${mode === 'pick' ? (slot === 'p' || slot === 's' ? 'Click to inspect on the bench · click again or EQUIP to take it' : 'Click to equip') : 'Click a section to change it · double-click a loadout to rename it'}</span>
          ${mode === 'pick' && (slot === 'p' || slot === 's') && this.ldShown && this.ldShown !== (slot === 'p' ? this.primary : this.secondary) ? `<button data-a="equip">EQUIP ${WEAPONS[this.ldShown].short}</button>` : ''}
          <button class="primary" data-a="done">CONFIRM</button></div>
        </div>`;
      // ---- the five loadouts, a horizontal row (selected: inked, red rule and its actions)
      const slots = `<div class="ldslotrow">${this.presets.map((p, i) => `<div class="ldslotwrap ${i === this.activePreset ? 'on' : ''}">
          <button class="ldpreset ${i === this.activePreset ? 'on' : ''}" data-preset="${i}" title="Double-click to rename"><small>${i + 1}</small><span>${esc(p.name)}</span><em>${WEAPONS[p.p]?.short ?? ''} · ${WEAPONS[p.s]?.short ?? ''}</em></button>
          ${i === this.activePreset ? `<div class="ldslotacts"><button data-a="rename">${icon('manual')}RENAME</button><button data-a="editp">${icon('loadout')}EDIT</button></div>` : ''}
        </div>`).join('')}</div>`;
      let stage = '', bottom = '';
      if (mode === 'overview') {
        // ---- bench shows the hovered (or the primary) weapon full width
        const benchId: WeaponId = this.ldHover ?? this.primary;
        const d = WEAPONS[benchId];
        stage = `<div class="ldstage"><div class="ldbenchtag"><span class="eyebrow red">${benchId === this.secondary && this.ldHover ? 'SIDEARM' : 'PRIMARY'}</span><b>${d.name.toUpperCase()}</b><small>${CLS_NAME[d.cls]} · ${CALIBRE[d.id] ?? ''}</small></div>${bench(d)}</div>`;
        const P = WEAPONS[this.primary], S = WEAPONS[this.secondary];
        const sec = (k: string, cls: string, body: string) => `<button class="ldsec ${cls}" data-sec="${k}">${body}</button>`;
        bottom = `<div class="ldoverview paper-card">
            ${sec('p', 'wide', `<span class="ldsl">PRIMÆR · PRIMARY</span><span class="ldsimg">${thumb(this.primary)}</span><b>${P.short}</b><small>${CLS_NAME[P.cls]} · ${P.rpm} RPM · ${P.mag} RDS</small>`)}
            ${sec('s', 'wide', `<span class="ldsl">SEKUNDÆR · SECONDARY</span><span class="ldsimg">${thumb(this.secondary)}</span><b>${S.short}</b><small>${CLS_NAME[S.cls]} · ${S.rpm} RPM · ${S.mag} RDS</small>`)}
            ${sec('t', '', `<span class="ldsl">TAKTISK</span><span class="ldsic">${icon(this.tactical)}</span><b>${tac.name}</b><small>Tactical · ×${tac.count}</small>`)}
            ${sec('l', '', `<span class="ldsl">DØDELIG</span><span class="ldsic">${icon(this.lethal)}</span><b>${lethal.name.replace(' GRENADE', '')}</b><small>Lethal · ×${lethal.count}</small>`)}
            <div class="ldsec perks" title="Every soldier carries these: there are no perk slots in this mode"><span class="ldsl">FERDIGHETER · PERKS</span><span class="ldperks">${icon('quick')}<i>${icon('chevron')}</i>${icon('ping')}<i>${icon('chevron')}</i>${icon('squad')}</span><b>STANDARD ISSUE</b><small>Tac sprint · ping · squad orders</small></div>
            ${sec('f', '', `<span class="ldsl">FELTUTSTYR</span><span class="ldsic">${icon('trophy')}</span><b>TROPHY</b><small>Field upgrade · [H]</small>`)}
          </div>`;
      } else if (slot === 'p' || slot === 's') {
        const pool = slot === 'p' ? PRIMARIES : SECONDARIES;
        const cats = CATS.filter((c) => pool.some((id) => WEAPONS[id].cls === c.cls));
        const selId: WeaponId = slot === 's' ? this.secondary : this.primary;
        if (!cats.some((c) => c.cls === this.ldCat)) this.ldCat = WEAPONS[selId].cls;
        const list = pool.filter((id) => WEAPONS[id].cls === this.ldCat);
        const shown: WeaponId = this.ldShown && list.includes(this.ldShown) ? this.ldShown : list.includes(selId) ? selId : list[0] ?? selId;
        if (shown !== selId) this.ldShown = shown;
        const d = WEAPONS[shown];
        const card = (id: WeaponId) => {
          const w = WEAPONS[id];
          const eq = id === selId;
          return `<div class="ldcard ${eq ? 'eq' : ''} ${id === shown ? 'on' : ''}" data-id="${id}">${eq ? `<i class="chk">${icon('check')}</i>` : ''}<div class="th">${thumb(id)}</div><div class="cn">${w.short}</div><div class="cs">${CLS_NAME[w.cls]}</div>${eq ? '<div class="eqb">EQUIPPED</div>' : ''}</div>`;
        };
        stage = `<div class="ldstage pick">${info(d, WEAPONS[selId])}${bench(d)}</div>`;
        bottom = `<div class="ldpick"><div class="ldtabs">${cats.map((c) => `<button data-cat="${c.cls}" class="${c.cls === this.ldCat ? 'on' : ''}">${c.label}</button>`).join('')}</div>
          <div class="ldcar">${list.map(card).join('')}</div></div>`;
      } else {
        // tactical / lethal / field upgrade: the item's sheet beside the bench, the choices below
        const items = slot === 't' ? TACTICALS.map((t) => ({ id: t.id as string, name: t.name, desc: t.desc, count: t.count, sel: t.id === this.tactical }))
          : slot === 'l' ? LETHALS.map((l) => ({ id: l.id as string, name: l.name, desc: l.desc, count: l.count, sel: l.id === this.lethal }))
          : [{ id: 'trophy', name: 'TROPHY SYSTEM', desc: TROPHY_DESC, count: 1, sel: true }];
        const cur = items.find((i) => i.sel)!;
        const g = slot === 't' ? 't' : slot === 'l' ? 'l' : 'f';
        const ecard = (it: (typeof items)[0]) => `<div class="ldcard eqp ${it.sel ? 'eq on' : ''}" data-g="${g}" data-id="${it.id}">${it.sel ? `<i class="chk">${icon('check')}</i>` : ''}<div class="th ic">${icon(it.id, 'big')}</div><div class="cn">${it.name}</div><div class="cs">×${it.count} PER LIFE</div></div>`;
        stage = `<div class="ldstage pick">${eqInfo(cur.id, slot === 't' ? 'TACTICAL' : slot === 'l' ? 'LETHAL' : 'FIELD UPGRADE', cur.name, cur.desc, cur.count)}<div class="ldview ldeqview"><div class="ldeqbig">${icon(cur.id)}</div><div class="plate"><b>${cur.name}</b>${slot === 't' ? 'TACTICAL' : slot === 'l' ? 'LETHAL' : 'FIELD UPGRADE'} · ×${cur.count} PER LIFE</div></div></div>`;
        bottom = `<div class="ldpick"><div class="ldcar">${items.map(ecard).join('')}</div></div>`;
      }
      e.innerHTML = `<div class="ld">${head}${stage}${bottom}${slots}</div>`;
      // the 3D gun on the bench
      const view = e.querySelector('.ldview:not(.ldeqview)') as HTMLElement | null;
      if (view && this.preview) {
        const id = (mode === 'overview' ? this.ldHover ?? this.primary : this.ldShown ?? (slot === 's' ? this.secondary : this.primary)) as WeaponId;
        this.preview.show(view, id);
        const cv = view.querySelector('canvas');
        if (cv) view.insertBefore(cv, view.querySelector('svg'));
      } else this.preview?.stop();

      // ---- interactions
      e.querySelectorAll('[data-sec]').forEach((b) => {
        const k = (b as HTMLElement).dataset.sec as 'p' | 's' | 't' | 'l' | 'f';
        b.addEventListener('click', () => {
          this.ldMode = 'pick';
          this.ldSlot = k;
          this.ldCat = '';
          this.ldShown = null;
          render();
        });
        // hovering a weapon section puts that weapon on the bench
        if (k === 'p' || k === 's') {
          b.addEventListener('mouseenter', () => {
            const id = k === 'p' ? this.primary : this.secondary;
            if (this.ldHover === id) return;
            this.ldHover = id;
            const v = e.querySelector('.ldview') as HTMLElement | null;
            const tag = e.querySelector('.ldbenchtag');
            if (v && this.preview) this.preview.show(v, id);
            const d = WEAPONS[id];
            if (tag) tag.innerHTML = `<span class="eyebrow red">${k === 'p' ? 'PRIMARY' : 'SIDEARM'}</span><b>${d.name.toUpperCase()}</b><small>${CLS_NAME[d.cls]} · ${CALIBRE[d.id] ?? ''}</small>`;
            const cos = e.querySelectorAll('.ldview .co b');
            if (cos.length === 4) {
              cos[0].textContent = CALIBRE[d.id] ?? '—';
              cos[1].textContent = `${d.rpm} RPM`;
              cos[2].textContent = `${d.mag} + ${d.reserve}`;
              cos[3].textContent = `${d.range[0]}–${d.range[1]} m`;
            }
            const pl = e.querySelector('.ldview .plate');
            if (pl) pl.innerHTML = `<b>${d.short}</b>TEGNING NR. ${String(PRIMARIES.concat(SECONDARIES).indexOf(d.id as WeaponId) + 1).padStart(2, '0')} · ${CLS_NAME[d.cls]}`;
          });
        }
      });
      e.querySelectorAll('[data-preset]').forEach((b) => {
        const i = +(b as HTMLElement).dataset.preset!;
        b.addEventListener('click', () => {
          if (i === this.activePreset) return;
          this.selectPreset(i);
          this.ldCat = '';
          this.ldShown = null;
          this.ldHover = null;
          render();
        });
        b.addEventListener('dblclick', () => rename(i));
      });
      const rename = (i: number) => {
        const n = prompt('Loadout name', this.presets[i].name);
        if (n && n.trim()) {
          this.presets[i].name = n.trim().toUpperCase().slice(0, 16);
          this.savePresets();
          render();
        }
      };
      e.querySelector('[data-a=rename]')?.addEventListener('click', () => rename(this.activePreset));
      e.querySelector('[data-a=editp]')?.addEventListener('click', () => {
        this.ldMode = 'pick';
        this.ldSlot = 'p';
        this.ldCat = '';
        this.ldShown = null;
        render();
      });
      e.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => { this.ldCat = (b as HTMLElement).dataset.cat!; this.ldShown = null; render(); }));
      e.querySelectorAll('.ldcard').forEach((c) =>
        c.addEventListener('click', () => {
          const el = c as HTMLElement;
          const id = el.dataset.id!;
          // weapons: first click puts it on the bench (with the comparison), the second equips it
          if ((slot === 'p' || slot === 's') && this.ldShown !== id && id !== (slot === 'p' ? this.primary : this.secondary)) {
            this.ldShown = id as WeaponId;
            render();
            return;
          }
          if (slot === 'p') this.primary = id as WeaponId;
          else if (slot === 's') this.secondary = id as WeaponId;
          else if (el.dataset.g === 't') this.tactical = id as TacticalId;
          else if (el.dataset.g === 'l') this.lethal = id as LethalId;
          else return;
          this.ldShown = null;
          save();
          render();
        }),
      );
      e.querySelector('[data-a=equip]')?.addEventListener('click', () => {
        if (!this.ldShown) return;
        if (slot === 'p') this.primary = this.ldShown;
        else if (slot === 's') this.secondary = this.ldShown;
        this.ldShown = null;
        save();
        render();
      });
      e.querySelector('[data-a=overview]')?.addEventListener('click', () => {
        this.ldMode = 'overview';
        this.ldShown = null;
        this.ldHover = null;
        render();
      });
      e.querySelectorAll('[data-a=done]').forEach((b) => b.addEventListener('click', () => {
        e.classList.add('hidden');
        this.preview?.stop();
        this.updateMenuWeapon();
        this.handlers.onLoadout();
        if (this.loadoutBack === 'pause') this.pause.classList.remove('hidden');
      }));
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
        ${select('weather', 'Weather', [['auto', 'Random'], ['clear', 'Clear (sunny, no clouds)'], ['fair', 'Broken clouds'], ['overcast', 'Overcast'], ['rain', 'Rain'], ['snow', 'Snow showers']])}
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
        ${toggle('throwArc', 'Throw arc preview (dotted arc + landing ring while a grenade is held ready)')}
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

  // ---------------------------------------------------------------- end of match
  showEnd(winner: 0 | 1 | -1, myTeam: 0 | 1, rows: ScoreRow[], scores: [number, number], names: [string, string]) {
    const won = winner === myTeam;
    const title = winner === -1 ? 'UAVGJORT' : won ? 'SEIER' : 'NEDERLAG';
    const sub = winner === -1 ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT';
    this.end.innerHTML = `<div class="panel wide"><div class="eyebrow ${won ? '' : 'red'}" style="text-align:center">${sub} · KAMPEN ER OVER</div>
      <div class="ptitle big ${won ? 'win' : winner === -1 ? '' : 'loss'}">${title}</div>
      <div class="final"><span class="blue">${emblem(0)} ${names[0]} ${scores[0]}</span> &nbsp;—&nbsp; <span class="red">${scores[1]} ${names[1]} ${emblem(1)}</span></div>
      ${this.tableHTML(rows, names)}
      <div class="row"><button class="primary" data-a="again">PLAY AGAIN</button><button data-a="menu">MAIN MENU</button></div></div>`;
    this.end.querySelectorAll('.final .emblem').forEach((e) => ((e as HTMLElement).style.cssText = 'width:30px;height:30px;vertical-align:middle'));
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

  // ---------------------------------------------------------------- scoreboard: player rows
  /** ping text ("43", "43 · 2%", "HOST", "BOT", "…") → signal bars */
  private pingBars(p: string) {
    const ms = parseInt(p, 10);
    const q = p === 'HOST' ? 3 : Number.isNaN(ms) ? 0 : ms < 70 ? 3 : ms < 140 ? 2 : 1;
    return `<span class="bars q${q}"><i></i><i></i><i></i></span>`;
  }
  private tableHTML(rows: ScoreRow[], names: [string, string]) {
    const team = (t: 0 | 1) => {
      const r = rows.filter((x) => x.team === t).sort((a, b) => b.score - a.score);
      const total = r.reduce((a, x) => a + x.score, 0);
      return `<div class="sbteam ${t === 0 ? 'blue' : 'red'}"><div class="sbt">${emblem(t)}<b>${names[t]}</b><span>${total}</span></div>
        <div class="sbh"><span></span><span>NAME</span><span>K</span><span>D</span><span>A</span><span>CAP</span><span>SCORE</span><span>PING</span><span></span></div>${r
        .map((x) => {
          const e = this.sbExtra ? this.sbExtra(x.id) : null;
          const human = !x.bot && !!e;
          const ping = e ? (x.bot ? '' : e.ping) : '';
          const mic = !e || x.bot ? '' : `<i class="mic ${e.muted ? 'mute' : e.talk ? 'talk' : ''}">${icon(e.muted ? 'muted' : 'mic')}</i>`;
          return `<div class="sbr ${x.isPlayer && !x.bot && !e ? 'me' : ''} ${x.alive ? '' : 'dead'}" ${human ? `data-human="${x.id}"` : ''} data-name="${esc(x.name)}">${icon(x.role || 'rifleman')}<span class="nm">${esc(x.name)}${x.bot ? '<small>BOT</small>' : ''}</span><span>${x.kills}</span><span>${x.deaths}</span><span>${x.assists ?? 0}</span><span>${x.captures ?? 0}</span><span>${x.score}</span><span class="pg">${e && !x.bot ? `${ping.replace(/ ·.*/, '')}${this.pingBars(ping)}` : x.bot ? '—' : ''}</span>${mic || '<span></span>'}</div>`;
        })
        .join('')}</div>`;
    };
    return `<div class="sbwrap">${team(0)}${team(1)}</div>`;
  }

  private sbRows: ScoreRow[] = [];
  private sbNames: [string, string] = ['', ''];
  setScoreboard(v: boolean, rows?: ScoreRow[], names?: [string, string], meId = -1) {
    this.scoreboard.classList.toggle('hidden', !v);
    if (!v) {
      this.scoreboardCursor(false);
      return;
    }
    if (rows && names) {
      this.sbRows = rows;
      this.sbNames = names;
      this.scoreboard.innerHTML = this.tableHTML(rows, names);
      if (meId >= 0) this.scoreboard.querySelector(`[data-name="${CSS.escape(rows.find((r) => r.id === meId)?.name ?? '')}"]`)?.classList.add('me');
      if (this.sbExtra?.(-1)) this.scoreboard.insertAdjacentHTML('beforeend', `<div class="sbhint">${this.sbCursor ? 'CLICK A PLAYER: MUTE · REPORT' : 'HOLD TAB + RIGHT CLICK: CURSOR (MUTE / REPORT)'}</div>`);
      this.wireRows();
    }
  }
  private sbCursor = false;
  /** right-click while the scoreboard is up: a cursor to click rows (mute / report) */
  scoreboardCursor(on: boolean) {
    this.sbCursor = on;
    this.scoreboard.classList.toggle('cursor', on);
    if (!on) this.scoreboard.querySelector('.sbmenu')?.remove();
    const hint = this.scoreboard.querySelector('.sbhint');
    if (hint) hint.textContent = on ? 'CLICK A PLAYER: MUTE · REPORT · TAB / ESC TO CLOSE' : 'HOLD TAB + RIGHT CLICK: CURSOR (MUTE / REPORT)';
  }
  get scoreboardOpen() {
    return !this.scoreboard.classList.contains('hidden');
  }
  private wireRows() {
    this.scoreboard.querySelectorAll('[data-human]').forEach((r) =>
      r.addEventListener('click', (ev) => {
        if (!this.sbCursor) return;
        const id = +(r as HTMLElement).dataset.human!;
        const row = this.sbRows.find((x) => x.id === id);
        this.scoreboard.querySelector('.sbmenu')?.remove();
        const e = this.sbExtra?.(id);
        const m = h('div', 'sbmenu paper-card', `<b>${esc(row?.name ?? '')}</b><button data-x="mute">${icon(e?.muted ? 'speaker' : 'muted')}${e?.muted ? 'UNMUTE' : 'MUTE'} (CHAT + VOICE)</button><button data-x="report">${icon('report')}REPORT TO THE HOST</button>`);
        const me = ev as MouseEvent;
        m.style.left = `${me.clientX + 6}px`;
        m.style.top = `${me.clientY + 6}px`;
        this.scoreboard.appendChild(m);
        m.querySelector('[data-x=mute]')!.addEventListener('click', (x) => {
          x.stopPropagation();
          this.handlers.onMute?.(id);
          m.remove();
          this.scoreboard.innerHTML = this.tableHTML(this.sbRows, this.sbNames);
          this.scoreboard.insertAdjacentHTML('beforeend', `<div class="sbhint">CLICK A PLAYER: MUTE · REPORT · TAB / ESC TO CLOSE</div>`);
          this.wireRows();
        });
        m.querySelector('[data-x=report]')!.addEventListener('click', (x) => {
          x.stopPropagation();
          this.handlers.onReport?.(id);
          m.remove();
        });
      }),
    );
  }

  // ---------------------------------------------------------------- HUD
  private buildHUD() {
    const e = h('div', 'hud hidden');
    e.innerHTML = `
      <div class="top">
        <div class="scorebar">
          <div class="team blue">${emblem(0)}<span class="tn"></span><div class="prog"><i class="p0"></i></div><b class="s0">0</b></div>
          <div class="clock">10:00</div>
          <div class="team red"><b class="s1">0</b><div class="prog"><i class="p1"></i></div><span class="tn"></span>${emblem(1)}</div>
        </div>
        <div class="flags"></div>
        <div class="compass"><div class="strip"></div><div class="marks"></div><div class="needle"></div><div class="brg">000</div></div>
        <div class="loc"></div>
      </div>
      <div class="crosshair"><i class="l"></i><i class="r"></i><i class="t"></i><i class="b"></i><i class="dot"></i></div>
      <div class="hitmarker"><i></i><i></i><i></i><i></i><b></b><u></u></div>
      <div class="dmg"></div>
      <div class="feed"></div>
      <div class="notify"></div>
      <div class="popups"></div>
      <div class="prompt"></div>
      <div class="capbar hidden"><div class="cl"></div><div class="ct"></div><div class="cb"><i></i></div></div>
      <div class="flagmarks"></div>
      <div class="streaks ctx"></div>
      <div class="nades ctx"></div>
      <div class="health ctx gone"><span class="hl">HP</span><div class="hb"><i class="hf"></i></div><span class="hv">100</span></div>
      <div class="ammo ctx"><div class="wn"></div><div class="fm"></div><div class="nums"><b class="mag">30</b><span class="res">/ 120</span></div><div class="pips"></div></div>
      <div class="fps hidden"></div>
      <div class="scope hidden"><div class="ring"></div></div>`;
    const q = (s: string) => e.querySelector(s) as HTMLElement;
    for (const k of ['s0', 's1', 'p0', 'p1', 'clock', 'strip', 'marks', 'brg', 'loc', 'crosshair', 'hitmarker', 'hf', 'hv', 'mag', 'res', 'wn', 'fm', 'pips', 'prompt', 'fps', 'scope', 'health', 'ammo', 'streaks', 'nades']) this.els[k] = q('.' + k);
    this.feedEl = q('.feed');
    this.notifyEl = q('.notify');
    this.dmgEl = q('.dmg');
    this.popEl = q('.popups');
    // compass: 4 px per degree; chart bearings every 15° (three digits), cardinal letters, ticks every 5°
    let html = '';
    for (let d = -360; d <= 720; d += 5) {
      const deg = ((d % 360) + 360) % 360;
      const x = (d + 360) * 4;
      const lab = ({ 0: 'N', 45: 'NØ', 90: 'Ø', 135: 'SØ', 180: 'S', 225: 'SV', 270: 'V', 315: 'NV' } as Record<number, string>)[deg];
      if (lab) html += `<span style="left:${x}px" class="c ${deg === 0 ? 'n' : ''}">${lab}</span>`;
      else if (deg % 15 === 0) html += `<span style="left:${x}px">${String(deg).padStart(3, '0')}</span>`;
      html += `<i style="left:${x}px" class="${deg % 15 === 0 ? 'm' : ''}"></i>`;
    }
    this.els.strip.innerHTML = html;
    return e;
  }

  showHUD(v: boolean) {
    this.hud.classList.toggle('hidden', !v);
  }

  /** contextual HUD: what changed recently stays bright, what has nothing to say fades */
  private ctx = { hurtT: 99, lastHp: 100, ammoT: 0, lastMag: -1, lastWeapon: '', streakT: 0, eqT: 0, heading: 0 };
  updateHUD(s: HUDState, dt: number) {
    const e = this.els;
    const c = this.ctx;
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
    c.heading = deg;
    setStyle(e.strip, 'transform', `translateX(${(-(deg + 360) * 4).toFixed(1)}px)`);
    setText(e.brg, String(Math.round(deg) % 360).padStart(3, '0'));
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
    this.hitT = Math.max(0, this.hitT - dt);
    setStyle(e.hitmarker, 'opacity', '0');
    // health: only while hurt (and a few seconds after)
    if (s.health < c.lastHp - 0.5) c.hurtT = 0;
    c.lastHp = s.health;
    c.hurtT += dt;
    setCls(e.health, `health ctx ${s.health >= 99.5 && c.hurtT > 3 ? 'gone' : ''}`);
    setStyle(e.hf, 'width', `${s.health.toFixed(0)}%`);
    e.hf.classList.toggle('low', s.health < 35);
    setText(e.hv, String(Math.ceil(s.health)));
    // ammo: bright while shooting / reloading / aiming / low, quiet otherwise
    if (s.mag !== c.lastMag || s.weapon !== c.lastWeapon || s.reloading || s.ads > 0.3) c.ammoT = 0;
    c.lastMag = s.mag;
    c.lastWeapon = s.weapon;
    c.ammoT += dt;
    const lowAmmo = s.magSize > 0 && s.mag <= Math.ceil(s.magSize * 0.25);
    setCls(e.ammo, `ammo ctx ${c.ammoT > 4 && !lowAmmo ? 'quiet' : ''}`);
    setText(e.mag, s.magSize > 0 ? String(s.mag) : '∞');
    e.mag.classList.toggle('low', lowAmmo);
    setText(e.res, s.magSize > 0 ? `/ ${s.reserve}` : '');
    setText(e.wn, s.weapon);
    const fm = s.mode.toLowerCase();
    setHTML(e.fm, `${icon('fm_' + (['auto', 'burst', 'semi', 'bolt', 'pump'].includes(fm) ? fm : 'semi'))}${s.mode}`);
    const pipKey = `${s.mag}/${s.magSize}`;
    if (e.pips.dataset.k !== pipKey) {
      e.pips.dataset.k = pipKey;
      e.pips.innerHTML = Array.from({ length: Math.min(s.magSize, 40) }, (_, i) => `<i class="${i < s.mag ? '' : 'e'}"></i>`).join('');
    }
    // killstreaks / equipment fade when nothing changes
    c.streakT += dt;
    c.eqT += dt;
    setCls(e.streaks, `streaks ctx ${c.streakT > 6 && !this.streakReady ? 'quiet' : ''}`);
    setCls(e.nades, `nades ctx ${c.eqT > 5 ? 'quiet' : ''}`);
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
    // damage arcs fade
    for (const el of Array.from(this.dmgEl.children) as HTMLElement[]) {
      const life = parseFloat(el.dataset.life || '0') - dt;
      el.dataset.life = String(life);
      el.style.opacity = String(Math.max(0, Math.min(1, life / 0.8)));
      if (life <= 0) el.remove();
    }
  }

  /** flags, pings, waypoint and spotted enemies on the compass ribbon */
  private compassPool: HTMLElement[] = [];
  compassMarks(list: CompassMark[]) {
    const host = this.els.marks;
    let n = 0;
    for (const mk of list) {
      let d = mk.bearing - this.ctx.heading;
      d = ((d % 360) + 540) % 360 - 180;
      if (Math.abs(d) > 58) continue;
      let el = this.compassPool[n];
      const tag = mk.kind === 'flag' ? 'B' : 'I';
      if (!el || el.tagName !== tag) {
        el?.remove();
        el = document.createElement(tag.toLowerCase());
        host.appendChild(el);
        this.compassPool[n] = el;
      }
      setCls(el, mk.kind === 'flag' ? (mk.rel ?? 'n') : mk.kind);
      if (mk.kind === 'flag') setText(el, mk.label ?? '');
      setStyle(el, 'transform', `translateX(${(d * 4).toFixed(1)}px) translateX(-50%)${mk.kind === 'ping' || mk.kind === 'foe' ? ' rotate(45deg)' : ''}`);
      el.style.display = '';
      n++;
    }
    for (let i = n; i < this.compassPool.length; i++) this.compassPool[i].style.display = 'none';
  }

  /** Hitmarker shapes: ticks (normal), short thin ticks (limb / armour), gold ticks + diamond (head),
   *  red X with an expanding ring (kill), grey (through cover). Scales with damage. */
  hitmarker(kill: boolean, head: boolean, damage = 30, kind: '' | 'limb' | 'through' | 'low' = '') {
    const tpl = this.els.hitmarker;
    const el = tpl.cloneNode(true) as HTMLElement;
    el.className = `hitmarker live ${kill ? 'kill' : ''} ${head ? 'head' : ''} ${kind}`;
    el.style.opacity = '';
    el.style.setProperty('--hs', String(Math.min(1.6, 0.85 + damage / 90) * (kill ? 1.3 : 1)));
    el.style.setProperty('--hr', `${((Math.random() - 0.5) * 6).toFixed(1)}deg`);
    el.style.animationDuration = kill ? '0.55s' : '0.3s';
    tpl.parentElement!.appendChild(el);
    this.liveHits.push(el);
    while (this.liveHits.length > 14) this.liveHits.shift()!.remove();
    el.addEventListener('animationend', (ev) => {
      if (ev.target !== el) return;
      el.remove();
      const i = this.liveHits.indexOf(el);
      if (i >= 0) this.liveHits.splice(i, 1);
    });
  }
  private liveHits: HTMLElement[] = [];

  // ---------------------------------------------------------------- score popups
  /** one line in the stack right of the crosshair: "+100 CAPTURE", "+50 ASSIST", "SPOTTED" */
  popup(label: string, pts = 0, cls = '') {
    const el = h('div', `pp ${cls}`, `<b>${pts ? `+${pts}` : ''}</b><span>${esc(label)}</span>`);
    this.popEl.appendChild(el);
    while (this.popEl.children.length > 6) this.popEl.firstChild!.remove();
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3150);
  }
  /** legacy entry: total points + reasons (each reason becomes its own line) */
  killText(points: number, reasons: string[]) {
    if (!reasons.length) return this.popup('ELIMINATION', points, 'kill');
    for (const r of reasons) this.popup(r, reasons.length === 1 ? points : 0);
  }
  scoreEvent(points: number, label: string, kill = true) {
    if (!kill) return this.popup(label, points);
    return this.popup('ELIMINATION', points, 'kill');
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

  // ---------------------------------------------------------------- killstreak tracker
  private streakReady = false;
  /** a pip per kill up to the last streak (marks at each streak's cost); the streak icons light up when ready */
  updateStreaks(list: { name: string; key: string; kills: number; ready: boolean; active: boolean }[], streak: number) {
    const el = this.els.streaks;
    const key = list.map((s) => `${s.ready}${s.active}`).join() + streak;
    if (el.dataset.k === key) return;
    el.dataset.k = key;
    this.ctx.streakT = 0;
    this.streakReady = list.some((s) => s.ready);
    const max = Math.max(...list.map((s) => s.kills), 1);
    const marks = new Set(list.map((s) => s.kills));
    const pips = Array.from({ length: max }, (_, i) => `<i class="${i < streak ? 'on' : ''} ${marks.has(i + 1) ? 'mark' : ''}"></i>`).join('');
    const ic = (n: string) => (n === 'UAV' ? 'uav' : n.startsWith('MORTAR') ? 'mortar' : 'heli');
    el.innerHTML = `<div class="sks">${list
      .slice()
      .reverse()
      .map((s) => `<div class="sk ${s.ready ? 'ready' : ''} ${s.active ? 'active' : ''}"><em>${s.ready ? `[${s.key}]` : `${Math.min(streak, s.kills)}/${s.kills}`}</em><span>${s.name}</span><span class="si">${icon(ic(s.name))}</span></div>`)
      .join('')}</div><div class="pipcol">${pips}</div>`;
  }

  // ---------------------------------------------------------------- equipment row
  /** lethal / tactical: a ring that empties as they are used; field upgrade: a charge ring */
  updateNades(frags: number, cooking: number, tac: TacticalId = this.tactical, tacN = 0, lethal: LethalId = this.lethal, field = 0, c4Out = 0) {
    const el = this.els.nades;
    const key = `${frags}|${cooking > 0 ? Math.ceil(cooking * 10) : 0}|${tac}|${tacN}|${lethal}|${Math.floor(field * 40)}|${c4Out}`;
    if (el.dataset.k === key) return;
    if (el.dataset.k && el.dataset.k.split('|').slice(0, 5).join() !== key.split('|').slice(0, 5).join()) this.ctx.eqT = 0;
    if (field >= 1 && !(el.dataset.k ?? '').includes('|40|')) this.ctx.eqT = 0;
    el.dataset.k = key;
    const C = 125.66; // 2πr, r = 20
    const ring = (frac: number) => `<svg class="ring" viewBox="0 0 46 46"><circle class="bg" cx="23" cy="23" r="20"/><circle class="fg" cx="23" cy="23" r="20" style="stroke-dashoffset:${(C * (1 - Math.max(0, Math.min(1, frac)))).toFixed(1)}"/></svg>`;
    const lmax = LETHALS.find((l) => l.id === lethal)?.count ?? 2, tmax = TACTICALS.find((t) => t.id === tac)?.count ?? 1;
    const slot = (name: string, n: number, max: number, k: string) => `<div class="eqs ${n ? '' : 'empty'}">${ring(n / max)}${icon(name)}<b>${n}</b><em>${k}</em></div>`;
    const ready = field >= 1;
    const fu = `<div class="eqs fu ${ready ? 'ready' : ''}">${ring(field)}${icon('trophy')}<b>${ready ? '✓' : Math.floor(field * 100)}</b><em>H</em></div>`;
    const det = c4Out > 0 ? `<div class="det">${frags > 0 ? '[F][F]' : '[G]'} DETONATE · ${c4Out}</div>` : '';
    el.innerHTML = slot(lethal, frags, lmax, 'G') + slot(tac, tacN, tmax, 'T') + fu + det + (cooking > 0 ? `<div class="cook"><i style="width:${(cooking / 3.5) * 100}%"></i><b>${cooking.toFixed(1)}</b></div>` : '');
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
  /** Context prompt under the crosshair ([F] OPEN DOOR ...). */
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
    while (el.children.length < angles.length) el.appendChild(h('i', '', `<b>${icon('frag')}</b>`));
    Array.from(el.children).forEach((c, i) => {
      const e = c as HTMLElement;
      e.style.display = i < angles.length ? '' : 'none';
      if (i < angles.length) {
        e.style.transform = `rotate(${angles[i]}rad) translateY(-118px)`;
        (e.firstElementChild as HTMLElement).style.transform = `rotate(${-angles[i]}rad)`;
      }
    });
  }

  /**
   * Damage direction arc (screen angle, radians, 0 = straight ahead). bullet: a thin red arc with
   * an inward tick; explosion: a heavy jagged arc, wider; fire: a dashed orange arc.
   */
  damageFrom(angle: number, kind: 'bullet' | 'explosion' | 'fire' = 'bullet') {
    const R = 118;
    const span = kind === 'explosion' ? 0.62 : kind === 'fire' ? 0.42 : 0.3;
    const arc = (r: number) => {
      const a0 = -Math.PI / 2 - span, a1 = -Math.PI / 2 + span;
      return `M${(Math.cos(a0) * r).toFixed(1)} ${(Math.sin(a0) * r).toFixed(1)} A${r} ${r} 0 0 1 ${(Math.cos(a1) * r).toFixed(1)} ${(Math.sin(a1) * r).toFixed(1)}`;
    };
    let body = '';
    if (kind === 'explosion') {
      // jagged inner edge: a zigzag between two radii
      let zz = '';
      const n = 14;
      for (let i = 0; i <= n; i++) {
        const a = -Math.PI / 2 - span + (i / n) * span * 2;
        const r = i % 2 ? R - 16 : R - 7;
        zz += `${i ? 'L' : 'M'}${(Math.cos(a) * r).toFixed(1)} ${(Math.sin(a) * r).toFixed(1)} `;
      }
      body = `<path d="${arc(R)}" stroke="#F0453C" stroke-width="9" fill="none" stroke-linecap="round" opacity=".9"/><path d="${zz}" stroke="#F2B544" stroke-width="2.4" fill="none" stroke-linejoin="round"/>`;
    } else if (kind === 'fire') {
      body = `<path d="${arc(R)}" stroke="#F2B544" stroke-width="6" fill="none" stroke-dasharray="7 6" stroke-linecap="round"/>`;
    } else {
      body = `<path d="${arc(R)}" stroke="#F0453C" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M-6 ${-R + 8}L0 ${-R + 18}L6 ${-R + 8}" stroke="#F4EFE3" stroke-width="2" fill="none" stroke-linejoin="round"/>`;
    }
    const svg = h('div', '', `<svg viewBox="-160 -160 320 320" style="filter:drop-shadow(0 0 2px rgba(5,10,20,.6))"><g transform="rotate(${((angle * 180) / Math.PI).toFixed(1)})">${body}</g></svg>`);
    svg.dataset.life = kind === 'explosion' ? '2.2' : '1.6';
    this.dmgEl.appendChild(svg);
    while (this.dmgEl.children.length > 8) this.dmgEl.firstChild!.remove();
  }

  notify(text: string, sub = '', cls = '') {
    const n = h('div', `note ${cls}`, `<b>${text}</b>${sub ? `<span>${sub}</span>` : ''}`);
    this.notifyEl.prepend(n);
    while (this.notifyEl.children.length > 3) this.notifyEl.lastChild!.remove();
    setTimeout(() => n.classList.add('out'), 1800);
    setTimeout(() => n.remove(), 2400);
  }

  // ---------------------------------------------------------------- kill feed
  /** what goes between the names: the weapon's silhouette, or a glyph for knives / explosions / fire */
  private feedWeapon(w: string) {
    const lw = w.toLowerCase();
    if (/knife|melee|bayonet/.test(lw)) return icon('melee');
    if (/grenade|frag|c4|claymore|sticky|mortar|explosive|helicopter|heli/.test(lw)) return icon(/mortar/.test(lw) ? 'mortar' : /heli/.test(lw) ? 'heli' : 'explosion');
    if (/fire|burn/.test(lw)) return icon('fire');
    if (/bounds|fall|map/.test(lw)) return icon('fall');
    const url = this.weaponIcon?.(w);
    return url ? `<img alt="" src="${url}">` : `<span class="wn">${esc(w.toUpperCase())}</span>`;
  }
  /** the player's own name (their kills / deaths are highlighted in the feed) */
  meName = '';
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
      .map((f) => `<div class="k ${f.killer === this.meName || f.victim === this.meName ? 'mine' : ''}" data-t="${f.t}"><span class="${f.killerTeam === 0 ? 'blue' : 'red'}">${esc(f.killer)}</span>${this.feedWeapon(f.weapon)}${f.headshot ? icon('headshot', 'hs') : ''}${f.wallbang ? icon('wallbang') : ''}<span class="${f.victimTeam === 0 ? 'blue' : 'red'}">${esc(f.victim)}</span></div>`)
      .join('');
  }

  // ---------------------------------------------------------------- death screen
  private deathKey = '';
  showDeath(v: boolean, killer = '', weapon = '', t = 0, killerTeam: 0 | 1 = 1) {
    this.deathEl.classList.toggle('hidden', !v);
    if (!v) {
      this.deathKey = '';
      return;
    }
    const key = `${killer}|${weapon}|${Math.ceil(t)}|${this.activePreset}`;
    if (key === this.deathKey) return;
    this.deathKey = key;
    const url = weapon ? this.weaponIcon?.(weapon) : null;
    const cards = this.presets.map((p, i) => `<div class="dlo ${i === this.activePreset ? 'on' : ''}"><b>${i + 1}</b><span>${esc(p.name)}</span><small>${WEAPONS[p.p]?.short ?? ''} · ${WEAPONS[p.s]?.short ?? ''}</small></div>`).join('');
    setHTML(this.deathEl, `<div class="killer paper-card">${emblem(killerTeam)}<div><div class="kb">FALT · ELIMINATED BY</div><div class="kn">${esc(killer)}</div><div class="kw">${esc(weapon)}</div></div>${url ? `<img alt="" src="${url}">` : ''}</div>
      <div class="rs">REDEPLOYING IN ${Math.max(0, Math.ceil(t))} S</div><div class="dloadouts">${cards}</div><div class="dlhint">1–5 · LOADOUT FOR YOUR NEXT LIFE</div>`);
    const em = this.deathEl.querySelector('.killer .emblem') as HTMLElement | null;
    if (em) em.style.color = killerTeam === 0 ? 'var(--sea-2)' : 'var(--red)';
  }
}
