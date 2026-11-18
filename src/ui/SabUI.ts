import { icon, emblem } from './Icons';
import { SHOP, ShopItem, Seat, Kit, NADES, Nade, Sabotage, SabStats, RoundEnd } from '../game/Sabotage';
import { WEAPONS } from '../weapons/WeaponDefs';

/**
 * Sabotasje HUD (Update 42), in the "Sjøkart" language: a round bar at the top (score, round
 * clock, a portrait per soldier that greys out on death, the charge carrier marked), your money
 * and kit bottom-left, a plant / defuse progress ring with the wire panel, a buy menu on paper,
 * the round-end card (why the round ended, MVP, what you earned) and the match report.
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const kr = (n: number) => `${Math.round(n).toLocaleString('nb-NO').replace(/ /g, ' ')} kr`;
const NADE_ICON: Record<Nade, string> = { he: 'he', fire: 'molotov', flash: 'flash', smoke: 'smoke', decoy: 'decoy' };
const NADE_NAME: Record<Nade, string> = { he: 'HE', fire: 'FIRE', flash: 'FLASH', smoke: 'SMOKE', decoy: 'DECOY' };
export const WIRE_COLS = ['#d7262e', '#2f6aa8', '#e8b416'];
export const WIRE_NAMES = ['RED', 'BLUE', 'YELLOW'];

export interface Portrait { id: number; team: 0 | 1; name: string; alive: boolean; hp: number; me: boolean; charge: boolean; bounty: number; weapon: string; money?: number }

export class SabUI {
  root: HTMLElement;
  private top: HTMLElement;
  private money: HTMLElement;
  private kit: HTMLElement;
  private prog: HTMLElement;
  private wires: HTMLElement;
  private card: HTMLElement;
  private center: HTMLElement;
  private buy: HTMLElement;
  private marks: HTMLElement;
  private spec: HTMLElement;
  private moneyShown = -1;
  buyOpen = false;
  /** set by the game: buy / sell an item (returns '' or why not) */
  onBuy: ((id: string) => string) | null = null;
  onSell: ((id: string) => void) | null = null;
  onRebuy: (() => void) | null = null;
  onCloseBuy: (() => void) | null = null;
  onWire: ((w: number) => void) | null = null;

  constructor(hud: HTMLElement, overlay: HTMLElement) {
    const el = document.createElement('div');
    el.className = 'sab hidden';
    el.innerHTML = `
      <div class="sab-top"></div>
      <div class="sab-money"></div>
      <div class="sab-kit"></div>
      <div class="sab-prog hidden"></div>
      <div class="sab-wires hidden"></div>
      <div class="sab-center"></div>
      <div class="sab-marks"></div>
      <div class="sab-spec hidden"></div>
      <div class="sab-card hidden"></div>`;
    hud.appendChild(el);
    this.root = el;
    const q = (s: string) => el.querySelector(s) as HTMLElement;
    this.top = q('.sab-top');
    this.money = q('.sab-money');
    this.kit = q('.sab-kit');
    this.prog = q('.sab-prog');
    this.wires = q('.sab-wires');
    this.card = q('.sab-card');
    this.center = q('.sab-center');
    this.marks = q('.sab-marks');
    this.spec = q('.sab-spec');
    // the buy menu sits over the HUD and takes the pointer
    this.buy = document.createElement('div');
    this.buy.className = 'sab-buy paper-card hidden';
    overlay.appendChild(this.buy);
  }

  show(v: boolean) {
    this.root.classList.toggle('hidden', !v);
    document.body.classList.toggle('sab-mode', v);
    if (!v) this.closeBuy();
  }

  // ---------------------------------------------------------------- top bar
  private topKey = '';
  topBar(s: Sabotage, myTeam: 0 | 1, names: [string, string], portraits: Portrait[]) {
    const t = Math.max(0, s.timer);
    const m = Math.floor(t / 60), sec = Math.floor(t % 60);
    const planted = s.phase === 'planted';
    const clock = s.phase === 'buy' ? `${Math.ceil(t)}` : `${m}:${String(sec).padStart(2, '0')}`;
    const side = (team: 0 | 1) => (s.atk === team ? 'ANGRIPERE' : 'FORSVARERE');
    const mine = portraits.filter((p) => p.team === myTeam), theirs = portraits.filter((p) => p.team !== myTeam);
    const pp = (p: Portrait) => `<div class="pt ${p.alive ? '' : 'dead'} ${p.me ? 'me' : ''} ${p.team === myTeam ? 'f' : 'e'}" title="${esc(p.name)}">
        <i style="height:${p.alive ? Math.max(0, Math.min(100, p.hp)) : 0}%"></i>${p.alive ? '' : icon('skull')}${p.charge ? `<u>${icon('charge')}</u>` : ''}${p.bounty ? `<s>${icon('bounty')}</s>` : ''}<span>${esc(p.name.slice(0, 7))}</span></div>`;
    const key = `${s.score}|${s.round}|${clock}|${s.phase}|${s.atk}|${portraits.map((p) => `${p.id}${p.alive ? 1 : 0}${Math.round(p.hp / 10)}${p.charge ? 1 : 0}${p.bounty}`).join(',')}`;
    if (key === this.topKey) return;
    this.topKey = key;
    this.top.innerHTML = `
      <div class="side f">${mine.map(pp).join('')}</div>
      <div class="mid">
        <div class="sc f"><em>${side(myTeam)}</em><b>${s.score[myTeam]}</b></div>
        <div class="clk ${planted ? 'planted' : ''} ${s.phase === 'buy' ? 'buy' : ''} ${t < 10 && s.phase === 'live' ? 'low' : ''}">
          ${planted ? `<span class="ch">${icon('charge')}</span>` : `<span class="t">${clock}</span>`}
          <small>${s.phase === 'buy' ? 'KJØPETID · BUY' : s.phase === 'post' ? 'RUNDE SLUTT' : planted ? 'LADNINGEN ER PLASSERT' : `RUNDE ${s.round}`}</small>
        </div>
        <div class="sc e"><b>${s.score[1 - myTeam]}</b><em>${side((1 - myTeam) as 0 | 1)}</em></div>
      </div>
      <div class="side e">${theirs.map(pp).join('')}</div>`;
    void names;
  }

  // ---------------------------------------------------------------- money and kit
  private kitKey = '';
  wallet(money: number, buy: boolean, side: 'atk' | 'def', hint = '') {
    if (money !== this.moneyShown) {
      const d = this.moneyShown >= 0 ? money - this.moneyShown : 0;
      this.moneyShown = money;
      this.money.innerHTML = `${icon('money')}<b>${kr(money)}</b>${d ? `<em class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : '−'}${kr(Math.abs(d))}</em>` : ''}`;
    }
    this.money.classList.toggle('buy', buy);
    this.money.dataset.hint = buy ? `[B] KJØP · BUY${hint ? '  ·  ' + hint : ''}` : '';
    this.money.classList.toggle('atk', side === 'atk');
  }
  kitBar(k: Kit, sel: { lethal: Nade | null; tactical: Nade | null }, armor: number, charge: boolean) {
    const key = JSON.stringify([k, sel, Math.round(armor), charge]);
    if (key === this.kitKey) return;
    this.kitKey = key;
    const n = NADES.filter((x) => k.nades[x] > 0)
      .map((x) => `<div class="nd ${sel.lethal === x || sel.tactical === x ? 'sel' : ''}">${icon(NADE_ICON[x])}<b>${k.nades[x]}</b><em>${x === 'he' || x === 'fire' ? 'G' : 'T'}</em></div>`)
      .join('');
    this.kit.innerHTML = `
      ${armor > 0 ? `<div class="ar">${icon(k.helmet ? 'helmet' : 'vest')}<b>${Math.round(armor)}</b></div>` : ''}
      ${k.cutters ? `<div class="ar">${icon('cutters')}</div>` : ''}
      ${charge ? `<div class="ar ch">${icon('charge')}<b>LADNING</b></div>` : ''}
      ${n}${n ? '<small>3 / 4: VELG GRANAT</small>' : ''}`;
  }

  // ---------------------------------------------------------------- plant / defuse
  progress(kind: 'plant' | 'defuse' | null, frac: number, label: string) {
    if (!kind) {
      this.prog.classList.add('hidden');
      return;
    }
    this.prog.classList.remove('hidden');
    const C = 2 * Math.PI * 34;
    this.prog.innerHTML = `<svg viewBox="0 0 80 80"><circle class="bg" cx="40" cy="40" r="34"/><circle class="fg ${kind}" cx="40" cy="40" r="34" style="stroke-dasharray:${C.toFixed(1)};stroke-dashoffset:${(C * (1 - Math.max(0, Math.min(1, frac)))).toFixed(1)}"/></svg><div class="pl">${icon(kind === 'plant' ? 'charge' : 'cutters')}<b>${esc(label)}</b></div>`;
  }
  /**
   * The wire panel. mode 'cut': defusing — [1] [2] [3] cuts a wire (ruled = a wrong wire the cutters
   * ruled out). mode 'pick': you just planted — [1] [2] [3] chooses the live wire.
   */
  private wireKey = '';
  wirePanel(mode: 'cut' | 'pick' | null, ruled = -1, chosen = -1, secs = 0) {
    if (!mode) {
      if (this.wireKey) {
        this.wireKey = '';
        this.wires.classList.add('hidden');
      }
      return;
    }
    const key = `${mode}|${ruled}|${chosen}|${Math.ceil(secs)}`;
    if (key === this.wireKey) return;
    this.wireKey = key;
    this.wires.classList.remove('hidden');
    const head = mode === 'cut' ? 'KUTT EN LEDNING · CUT A WIRE' : 'VELG LEVENDE LEDNING · CHOOSE THE LIVE WIRE';
    const sub = mode === 'cut' ? 'Riktig ledning: desarmert med en gang. Feil: den går av. · Right wire defuses now — wrong one sets it off.' : `Forsvarerne må gjette hvilken. · The defenders have to guess which. ${Math.ceil(secs)}s`;
    this.wires.innerHTML = `<div class="wh">${head}</div><div class="wl">${[0, 1, 2]
      .map((i) => `<button class="w ${ruled === i ? 'ruled' : ''} ${chosen === i ? 'chosen' : ''}" data-w="${i}" style="--wc:${WIRE_COLS[i]}"><i></i><b>${i + 1}</b><span>${WIRE_NAMES[i]}${ruled === i ? ' · TRYGG / SAFE' : ''}</span></button>`)
      .join('')}</div><div class="ws">${sub}</div>`;
    this.wires.querySelectorAll('[data-w]').forEach((b) => b.addEventListener('click', () => this.onWire?.(+(b as HTMLElement).dataset.w!)));
  }

  // ---------------------------------------------------------------- center messages, markers
  private centerT = 0;
  say(text: string, sub = '', cls = '', hold = 2.6) {
    this.center.innerHTML = `<b>${esc(text)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}`;
    this.center.className = `sab-center show ${cls}`;
    this.centerT = hold;
  }
  tick(dt: number) {
    if (this.centerT > 0 && (this.centerT -= dt) <= 0) this.center.className = 'sab-center';
    if (this.cardT > 0 && (this.cardT -= dt) <= 0) this.card.classList.add('hidden');
  }
  /** world markers projected by the game (charge, dropped guns, site letters) */
  private markPool: HTMLElement[] = [];
  markers(list: { x: number; y: number; label: string; cls: string; ico?: string; dist?: number }[]) {
    while (this.markPool.length < list.length) {
      const e = document.createElement('div');
      this.marks.appendChild(e);
      this.markPool.push(e);
    }
    this.markPool.forEach((e, i) => {
      const m = list[i];
      if (!m) {
        e.style.display = 'none';
        return;
      }
      e.style.display = '';
      e.className = `mk ${m.cls}`;
      e.style.transform = `translate(${m.x.toFixed(0)}px, ${m.y.toFixed(0)}px)`;
      const html = `${m.ico ? icon(m.ico) : ''}<b>${esc(m.label)}</b>${m.dist !== undefined ? `<small>${Math.round(m.dist)} m</small>` : ''}`;
      if (e.dataset.h !== html) {
        e.dataset.h = html;
        e.innerHTML = html;
      }
    });
  }
  spectating(name: string | null, hint = '') {
    this.spec.classList.toggle('hidden', !name);
    if (name) this.spec.innerHTML = `<small>SER PÅ · SPECTATING</small><b>${esc(name)}</b><em>${esc(hint)}</em>`;
  }

  // ---------------------------------------------------------------- round card
  private cardT = 0;
  roundCard(e: RoundEnd, myTeam: 0 | 1, atk: 0 | 1, myPay: number, mvpName: string, score: [number, number], nextNote: string) {
    const won = e.winner === myTeam;
    const sideWon = e.winner === atk ? 'ANGRIPERNE' : 'FORSVARERNE';
    const why = { elim: 'ALLE NEDKJEMPET · ELIMINATED', time: 'TIDEN GIKK UT · TIME RAN OUT', exploded: 'LADNINGEN GIKK AV · CHARGE DETONATED', defused: 'LADNINGEN DESARMERT · CHARGE DEFUSED' }[e.reason];
    this.card.className = `sab-card ${won ? 'won' : 'lost'}`;
    this.card.innerHTML = `<div class="rc-top"><em>RUNDE ${e.round}</em><b>${won ? 'VUNNET' : 'TAPT'}</b><span>${sideWon} VANT · ${why}</span></div>
      <div class="rc-score"><b class="f">${score[myTeam]}</b><i>–</i><b class="e">${score[1 - myTeam]}</b></div>
      ${e.mvp ? `<div class="rc-mvp">${icon('medal')}<span><small>RUNDENS MVP</small><b>${esc(mvpName)}</b><em>${esc(e.mvpWhy)}</em></span></div>` : ''}
      ${e.clutch ? `<div class="rc-clutch">CLUTCH 1v${e.clutch.vs} · +${kr(500 * e.clutch.vs)}</div>` : ''}
      <div class="rc-pay">${icon('money')}<b>+${kr(myPay)}</b>${nextNote ? `<small>${esc(nextNote)}</small>` : ''}</div>`;
    this.card.classList.remove('hidden');
    this.cardT = 5.2;
  }

  // ---------------------------------------------------------------- buy menu
  private buyArgs: { seat: Seat; sab: Sabotage; inSpawn: boolean } | null = null;
  private buyCat: ShopItem['cat'] = 'rifle';
  openBuy(seat: Seat, sab: Sabotage, inSpawn: boolean) {
    this.buyOpen = true;
    this.buyArgs = { seat, sab, inSpawn };
    this.buy.classList.remove('hidden');
    this.renderBuy();
  }
  refreshBuy(seat: Seat, sab: Sabotage, inSpawn: boolean) {
    if (!this.buyOpen) return;
    this.buyArgs = { seat, sab, inSpawn };
    this.renderBuy();
  }
  private closedAt = -1e9;
  /** the menu is open or only just closed (a pointer-lock change in flight is ours, not a pause) */
  buyRecent() {
    return this.buyOpen || performance.now() - this.closedAt < 1500;
  }
  closeBuy() {
    if (!this.buyOpen) return;
    this.buyOpen = false;
    this.closedAt = performance.now();
    this.buy.classList.add('hidden');
    this.onCloseBuy?.();
  }
  private renderBuy() {
    const a = this.buyArgs;
    if (!a) return;
    const { seat, sab } = a;
    const side = sab.side(seat.c.team);
    const cats: [ShopItem['cat'], string, string][] = [
      ['pistol', 'PISTOLER', 'pistol'], ['smg', 'MASKINPISTOLER', 'smg'], ['heavy', 'TUNGE', 'shotgun'], ['rifle', 'GEVÆRER', 'rifle'], ['gear', 'UTSTYR', 'vest'], ['nade', 'GRANATER', 'he'],
    ];
    const items = SHOP.filter((i) => i.cat === this.buyCat && (!i.side || i.side === side));
    const owned = (it: ShopItem) => sab.blocked(seat, it) === 'OWNED' || sab.blocked(seat, it) === 'FULL';
    const k = seat.kit;
    const loadout = `<div class="bl">
        <div><small>PRIMÆR</small><b>${k.primary ? esc(WEAPONS[k.primary].short) : '—'}</b></div>
        <div><small>SIDEVÅPEN</small><b>${esc(WEAPONS[k.secondary].short)}</b></div>
        <div><small>VERN</small><b>${k.armor > 0 ? (k.helmet ? 'VEST + HJELM' : 'VEST') : '—'}${k.cutters ? ' · KUTTER' : ''}</b></div>
        <div><small>GRANATER</small><b>${NADES.filter((n) => k.nades[n]).map((n) => `${NADE_NAME[n]}×${k.nades[n]}`).join(' ') || '—'}</b></div>
      </div>`;
    this.buy.innerHTML = `
      <div class="bh"><div><span class="eyebrow red">${side === 'atk' ? 'ANGRIPERE · ATTACKERS' : 'FORSVARERE · DEFENDERS'}</span><div class="h-display">KJØP · BUY</div></div>
        <div class="bm">${icon('money')}<b>${kr(seat.money)}</b></div></div>
      <div class="bc">${cats.map(([c, n, ic]) => `<button class="cat ${c === this.buyCat ? 'on' : ''}" data-cat="${c}">${icon(ic)}<span>${n}</span></button>`).join('')}</div>
      <div class="bi">${items
        .map((it) => {
          const why = sab.blocked(seat, it);
          const price = sab.price(seat, it);
          const ic = it.weapon ? '' : it.nade ? NADE_ICON[it.nade] : it.id === 'cutters' ? 'cutters' : it.id === 'vesthelm' ? 'helmet' : 'vest';
          return `<button class="it ${why ? 'off' : ''} ${owned(it) ? 'own' : ''}" data-id="${it.id}">
            <div class="ii">${it.weapon ? `<img data-w="${esc(WEAPONS[it.weapon].name)}" alt=""/>` : icon(ic)}</div>
            <div class="in"><b>${esc(it.name)}</b><small>${esc(it.desc)}</small></div>
            <div class="ip"><b>${price ? kr(price) : 'GRATIS'}</b>${why ? `<em>${why === 'NO MONEY' ? 'FOR LITE PENGER' : why === 'OWNED' ? 'EIER' : why === 'FULL' ? 'FULLT' : why}</em>` : ''}</div>
            ${seat.last.includes(it.id) ? `<span class="sell" data-sell="${it.id}">ANGRE · SELL</span>` : ''}
          </button>`;
        })
        .join('')}</div>
      ${loadout}
      <div class="bf"><button class="btn ghost" data-x="rebuy">KJØP SOM SIST · REBUY</button><span>${a.inSpawn ? '' : '<b class="warn">UTENFOR KJØPESONEN · OUT OF THE BUY ZONE</b>'}</span><button class="btn" data-x="close">FERDIG [B]</button></div>`;
    this.buy.querySelectorAll('[data-cat]').forEach((b) =>
      b.addEventListener('click', () => {
        this.buyCat = (b as HTMLElement).dataset.cat as ShopItem['cat'];
        this.renderBuy();
      }),
    );
    this.buy.querySelectorAll('[data-id]').forEach((b) =>
      b.addEventListener('click', (ev) => {
        const t = ev.target as HTMLElement;
        if (t.dataset.sell) {
          this.onSell?.(t.dataset.sell);
          return;
        }
        const r = this.onBuy?.((b as HTMLElement).dataset.id!) ?? '';
        if (r) b.classList.add('shake');
      }),
    );
    this.buy.querySelector('[data-x=rebuy]')?.addEventListener('click', () => this.onRebuy?.());
    this.buy.querySelector('[data-x=close]')?.addEventListener('click', () => this.closeBuy());
    // gun silhouettes (rendered by the game, cached)
    this.buy.querySelectorAll('img[data-w]').forEach((img) => {
      const url = this.weaponIcon?.((img as HTMLElement).dataset.w!);
      if (url) (img as HTMLImageElement).src = url;
    });
  }
  weaponIcon: ((name: string) => string | null) | null = null;

  // ---------------------------------------------------------------- match report
  report(rows: { name: string; team: 0 | 1; me: boolean; st: SabStats; rounds: number }[], myTeam: 0 | 1, score: [number, number], names: [string, string]): string {
    const tbl = (team: 0 | 1) => `<table class="sr"><thead><tr><th>${esc(names[team])}</th><th>K</th><th>D</th><th>A</th><th>ADR</th><th>ÅPN.</th><th>CLUTCH</th><th>MVP</th></tr></thead><tbody>${rows
      .filter((r) => r.team === team)
      .sort((a, b) => b.st.kills - a.st.kills || b.st.dmg - a.st.dmg)
      .map((r) => `<tr class="${r.me ? 'me' : ''}"><td>${esc(r.name)}</td><td>${r.st.kills}</td><td>${r.st.deaths}</td><td>${r.st.assists}</td><td>${Math.round(r.st.dmg / Math.max(1, r.rounds))}</td><td>${r.st.openings}</td><td>${r.st.clutches}</td><td>${r.st.mvps}</td></tr>`)
      .join('')}</tbody></table>`;
    return `<div class="sab-report"><div class="sr-score"><b class="f">${score[myTeam]}</b><i>–</i><b class="e">${score[1 - myTeam]}</b></div>${tbl(myTeam)}${tbl((1 - myTeam) as 0 | 1)}
      <div class="sr-note">ADR = snittskade per runde · average damage per round · ÅPN. = åpningsdrap · opening kills</div></div>`;
  }
}
export { kr, emblem };
