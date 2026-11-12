import { WEAPONS, PRIMARIES, SECONDARIES, WeaponDef } from '../weapons/WeaponDefs';
import type { WeaponId } from '../weapons/WeaponModels';
import { ATT_SLOTS, AttSlot, SLOT_LABEL, Build, options, lockReason, cleanBuild, defaultAtt, applyBuild, attById, prosCons, buildCount, Attachment } from '../weapons/Attachments';
import { icon } from './Icons';
import type { UI, LethalId, TacticalId } from './UI';
import { LETHALS, TACTICALS, CALIBRE } from './UI';

/**
 * Loadout screen (Update 36), rebuilt from scratch around three plain levels:
 *
 *   LOADOUT ── your five loadouts on the left, the selected one's kit on the right, the primary
 *     │        turning on the bench in the middle. Click a row to change it.
 *     ├─ WEAPON   pick a gun: categories on the left, the guns as cards, the focused gun's sheet on
 *     │           the right with every stat compared with what you carry. EQUIP / CUSTOMISE.
 *     │     └─ GUNSMITH  five attachment slots on the left, the gun with its parts in the middle,
 *     │                  the slot's choices on the right with their pros (green) and cons (red);
 *     │                  hover to preview the gun and the stat change, click to fit.
 *     └─ TACTICAL / LETHAL  the items as cards, click to equip.
 *
 * One BACK button (and Esc, and right-click) always goes up exactly one level; DONE closes. The
 * breadcrumb says where you are. Nothing hides behind modes, double-clicks or prompts.
 */

type Level = { k: 'home' } | { k: 'weapon'; slot: 'p' | 's' } | { k: 'smith'; slot: 'p' | 's'; att: AttSlot } | { k: 'equip'; slot: 't' | 'l' };

const CLS_ORDER: WeaponDef['cls'][] = ['Assault Rifle', 'SMG', 'LMG', 'Shotgun', 'Marksman', 'Sniper', 'Pistol'];
const CLS_LABEL: Record<string, string> = { 'Assault Rifle': 'Assault rifles', SMG: 'SMGs', LMG: 'LMGs', Shotgun: 'Shotguns', Marksman: 'Marksman', Sniper: 'Snipers', Pistol: 'Handguns' };
const CLS_ONE: Record<string, string> = { 'Assault Rifle': 'Assault rifle', SMG: 'SMG', LMG: 'LMG', Shotgun: 'Shotgun', Marksman: 'Marksman rifle', Sniper: 'Sniper rifle', Pistol: 'Handgun' };
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** the bars: 0..1, higher is better */
function stats(d: WeaponDef): { k: string; v: number }[] {
  const rc = 1 - Math.min(1, Math.log2(1 + d.recoil.v * 1.5 + d.recoil.h) / 3.2);
  return [
    { k: 'Damage', v: Math.min(1, (d.damage[0] * d.pellets) / 110) },
    { k: 'Fire rate', v: Math.min(1, d.rpm / 950) },
    { k: 'Range', v: Math.min(1, d.range[1] / 220) },
    { k: 'Accuracy', v: 1 - Math.min(1, d.hipSpread * 0.06 + d.adsSpread * 0.8 + d.bloomMax * 0.05 + d.pelletSpread * 0.012) },
    { k: 'Recoil control', v: rc },
    { k: 'Mobility', v: Math.min(1, d.speedMul * 0.75 + d.adsSpeedMul * 0.25) },
    { k: 'Aim speed', v: Math.max(0, 1 - d.adsTime / 0.5) },
    { k: 'Reload speed', v: Math.max(0, 1 - (d.perShell ? d.perShell * 3 : d.reload) / 4.6) },
  ];
}
const zoomLabel = (z: number) => (z >= 1.9 ? '3×' : z >= 1.4 ? `${z.toFixed(1)}×` : '1×');
function numbers(d: WeaponDef) {
  return [
    ['Magazine', d.pellets > 1 && d.mag <= 8 ? `${d.mag} shells` : `${d.mag}`],
    ['Rate', `${d.rpm} rpm`],
    ['Aim', `${Math.round(d.adsTime * 1000)} ms`],
    ['Reload', `${(d.perShell ? d.perShell : d.reload).toFixed(2)} s${d.perShell ? '/shell' : ''}`],
  ];
}

/** stat bars: cur against base; changed bars show the gain (green) or loss (red) as a segment */
function bars(cur: WeaponDef, base: WeaponDef | null) {
  const a = stats(cur), b = base ? stats(base) : null;
  return a.map((s, i) => {
    const v = Math.max(0.03, s.v), o = b ? Math.max(0.03, b[i].v) : v;
    const dl = Math.round((v - o) * 100);
    const lo = Math.min(v, o), hi = Math.max(v, o);
    return `<div class="lo-bar"><span>${s.k}</span><b><i style="width:${(lo * 100).toFixed(1)}%"></i>${dl ? `<s class="${dl < 0 ? 'neg' : ''}" style="left:${(lo * 100).toFixed(1)}%;width:${((hi - lo) * 100).toFixed(1)}%"></s>` : ''}</b><em class="${dl > 0 ? 'up' : dl < 0 ? 'down' : ''}">${dl ? (dl > 0 ? '+' : '−') + Math.abs(dl) : Math.round(v * 100)}</em></div>`;
  }).join('');
}
function numRow(cur: WeaponDef, base: WeaponDef | null) {
  const a = numbers(cur), b = base ? numbers(base) : null;
  return `<div class="lo-nums">${a.map(([k, v], i) => `<div class="${b && b[i][1] !== v ? 'chg' : ''}"><small>${k}</small>${v}</div>`).join('')}</div>`;
}

export function openLoadout(ui: UI, back: 'menu' | 'pause', note: string) {
  const el = ui.loadoutEl;
  const stack: Level[] = [{ k: 'home' }];
  let focusW: WeaponId | null = null; // the gun on the bench in the weapon picker
  let catSel: WeaponDef['cls'] | null = null;
  let hoverAtt: string | null = null; // previewed attachment in the gunsmith
  let renaming = false;
  const top = () => stack[stack.length - 1];
  const gunOf = (slot: 'p' | 's') => (slot === 'p' ? ui.primary : ui.secondary);
  const buildOf = (slot: 'p' | 's') => cleanBuild(gunOf(slot), WEAPONS[gunOf(slot)], slot === 'p' ? ui.primaryBuild : ui.secondaryBuild);
  const setBuild = (slot: 'p' | 's', b: Build) => {
    if (slot === 'p') ui.primaryBuild = b;
    else ui.secondaryBuild = b;
    ui.commitLoadout();
  };
  const thumb = (id: WeaponId) => (ui.preview ? `<img alt="" src="${ui.preview.thumbnail(id)}">` : '');

  const go = (l: Level) => {
    stack.push(l);
    hoverAtt = null;
    ui.sfx('uiConfirm', 0.5);
    render();
  };
  const up = () => {
    if (renaming) {
      renaming = false;
      render();
      return;
    }
    if (stack.length > 1) {
      stack.pop();
      hoverAtt = null;
      ui.sfx('uiBack', 0.5);
      render();
    } else close();
  };
  const close = () => {
    window.removeEventListener('keydown', onKey, true);
    el.removeEventListener('contextmenu', onCtx);
    ui.closeLoadout();
  };
  const onKey = (e: KeyboardEvent) => {
    if (el.classList.contains('hidden')) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      up();
    } else if (e.code === 'Enter' && !renaming && stack.length === 1) {
      e.preventDefault();
      close();
    }
  };
  const onCtx = (e: Event) => {
    e.preventDefault();
    up();
  };
  window.addEventListener('keydown', onKey, true);
  el.addEventListener('contextmenu', onCtx);

  // ------------------------------------------------------------------ pieces
  const crumbs = () => {
    const p = ui.presets[ui.activePreset];
    const parts: string[] = ['Loadouts', esc(p.name)];
    const l = top();
    if (l.k === 'weapon') parts.push(l.slot === 'p' ? 'Primary' : 'Secondary');
    if (l.k === 'smith') parts.push(l.slot === 'p' ? 'Primary' : 'Secondary', `Gunsmith · ${WEAPONS[gunOf(l.slot)].short}`);
    if (l.k === 'equip') parts.push(l.slot === 't' ? 'Tactical' : 'Lethal');
    return parts.map((t, i) => `<span class="${i === parts.length - 1 ? 'on' : ''}">${t}</span>`).join('<i>›</i>');
  };
  const header = () => `<header class="lo-head">
      <button class="lo-back" data-a="up">${icon('chevron')}<span>${stack.length > 1 ? 'Back' : 'Close'}</span></button>
      <nav class="lo-crumbs">${crumbs()}</nav>
      ${note ? `<div class="lo-note">${note}</div>` : ''}
      <div class="lo-headr"><span class="lo-keys"><kbd>Esc</kbd> back${stack.length === 1 ? ' · <kbd>Enter</kbd> done' : ''}</span>
      <button class="lo-done" data-a="done">Done</button></div>
    </header>`;
  const stage = (label: string, name: string, sub: string) => `<div class="lo-stage"><div class="lo-tag"><small>${label}</small><b>${esc(name)}</b><span>${sub}</span></div><div class="lo-bench"></div></div>`;

  // ------------------------------------------------------------------ levels
  const home = () => {
    const p = ui.presets[ui.activePreset];
    const P = WEAPONS[ui.primary], S = WEAPONS[ui.secondary];
    const tac = TACTICALS.find((t) => t.id === ui.tactical)!, leth = LETHALS.find((l) => l.id === ui.lethal)!;
    const list = ui.presets.map((q, i) => i === ui.activePreset && renaming
      ? `<div class="lo-preset on"><small>${i + 1}</small><input class="lo-rename" maxlength="16" value="${esc(q.name)}"></div>`
      : `<button class="lo-preset ${i === ui.activePreset ? 'on' : ''}" data-preset="${i}"><small>${i + 1}</small><span><b>${esc(q.name)}</b><em>${WEAPONS[q.p]?.short ?? ''} · ${WEAPONS[q.s]?.short ?? ''}</em></span>${i === ui.activePreset ? `<i class="lo-ren" data-a="rename" title="Rename">${icon('manual')}</i>` : ''}</button>`).join('');
    const pb = buildOf('p'), sb = buildOf('s');
    const chips = (wid: WeaponId, b: Build) => {
      const n = buildCount(wid, b);
      return n ? `<span class="lo-chips">${ATT_SLOTS.filter((s) => b[s] !== defaultAtt(wid, s)).map((s) => `<i>${attById(s, b[s])?.name ?? ''}</i>`).join('')}</span>` : '<span class="lo-chips none">Factory build</span>';
    };
    const wrow = (slot: 'p' | 's', d: WeaponDef, b: Build) => `<div class="lo-row weapon" data-go="${slot}">
        <div class="lo-rowmain"><small>${slot === 'p' ? 'Primary' : 'Secondary'}</small><b>${d.name}</b><span>${CLS_ONE[d.cls]} · ${CALIBRE[d.id] ?? ''}</span>${chips(d.id as WeaponId, b)}</div>
        <div class="lo-rowimg">${thumb(d.id as WeaponId)}</div>
        <div class="lo-rowacts"><button data-go="${slot}">Change</button>${options(d.id as WeaponId, d, 'optic').length + options(d.id as WeaponId, d, 'muzzle').length + options(d.id as WeaponId, d, 'mag').length ? `<button class="hi" data-smith="${slot}">${icon('loadout')}Gunsmith</button>` : ''}</div>
      </div>`;
    const erow = (slot: 't' | 'l', kind: string, it: { id: string; name: string; count: number; desc: string }) => `<button class="lo-row item" data-eq="${slot}">
        <span class="lo-ic">${icon(it.id)}</span><div class="lo-rowmain"><small>${kind}</small><b>${it.name.toLowerCase()}</b><span>×${it.count} per life</span></div><span class="lo-chev">${icon('chevron')}</span></button>`;
    return `<div class="lo-body home">
      <aside class="lo-side"><div class="lo-h">Loadouts</div>${list}<p class="lo-tip">Your selected loadout is used on your next spawn.</p></aside>
      ${stage('Primary', P.name, `${CLS_ONE[P.cls]} · ${CALIBRE[P.id] ?? ''}`)}
      <section class="lo-panel"><div class="lo-h">${esc(p.name)}</div>
        ${wrow('p', applyBuild(P, pb), pb)}${wrow('s', applyBuild(S, sb), sb)}
        <div class="lo-pair">${erow('t', 'Tactical', tac)}${erow('l', 'Lethal', leth)}</div>
        <div class="lo-row fixed"><span class="lo-ic">${icon('trophy')}</span><div class="lo-rowmain"><small>Field upgrade</small><b>Trophy system</b><span>Press H · standard issue</span></div></div>
      </section>
    </div>`;
  };

  const weapon = (slot: 'p' | 's') => {
    const pool = slot === 'p' ? PRIMARIES : SECONDARIES;
    const cur = gunOf(slot);
    const cats = CLS_ORDER.filter((c) => pool.some((id) => WEAPONS[id].cls === c));
    if (!catSel || !cats.includes(catSel)) catSel = WEAPONS[focusW ?? cur].cls;
    if (!cats.includes(catSel)) catSel = cats[0];
    const list = pool.filter((id) => WEAPONS[id].cls === catSel);
    const f = focusW && pool.includes(focusW) ? focusW : list.includes(cur) ? cur : list[0];
    focusW = f;
    const d = WEAPONS[f];
    const eqd = applyBuild(WEAPONS[cur], buildOf(slot));
    const card = (id: WeaponId) => {
      const w = WEAPONS[id];
      return `<button class="lo-card ${id === f ? 'on' : ''} ${id === cur ? 'eq' : ''}" data-w="${id}">${id === cur ? `<i class="lo-eq">${icon('check')}Equipped</i>` : ''}<div class="lo-cimg">${thumb(id)}</div><b>${w.short}</b><span>${w.damage[0]}${w.pellets > 1 ? '×' + w.pellets : ''} dmg · ${w.rpm} rpm</span></button>`;
    };
    const same = f === cur;
    return `<div class="lo-body pick">
      <aside class="lo-side">${cats.map((c) => `<button class="lo-cat ${c === catSel ? 'on' : ''}" data-cat="${c}">${CLS_LABEL[c]}<small>${pool.filter((id) => WEAPONS[id].cls === c).length}</small></button>`).join('')}</aside>
      <div class="lo-mid">${stage(CLS_ONE[d.cls], d.name, CALIBRE[d.id] ?? '')}<div class="lo-cards">${list.map(card).join('')}</div></div>
      <section class="lo-panel sheet"><div class="lo-h">${same ? 'Equipped' : `Compared with your ${WEAPONS[cur].short}`}</div>
        <p class="lo-desc">${d.desc}</p>
        <div class="lo-bars">${bars(same ? eqd : d, same ? null : eqd)}</div>
        ${numRow(same ? eqd : d, same ? null : eqd)}
        <div class="lo-acts">${same ? '' : `<button class="lo-primary" data-a="equip">Equip ${d.short}</button>`}${options(f, d, 'optic').length + options(f, d, 'muzzle').length + options(f, d, 'mag').length ? `<button class="${same ? 'lo-primary' : ''}" data-a="equipsmith">${icon('loadout')}${same ? 'Gunsmith' : 'Equip & customise'}</button>` : ''}</div>
        ${same ? '' : '<p class="lo-tip"><span class="g">Green</span> is better, <span class="r">red</span> worse than what you carry now.</p>'}
      </section>
    </div>`;
  };

  const smith = (slot: 'p' | 's', att: AttSlot) => {
    const wid = gunOf(slot);
    const base = WEAPONS[wid];
    const b = buildOf(slot);
    const cur = applyBuild(base, b);
    const opts = options(wid, base, att);
    const prevB = hoverAtt ? { ...b, [att]: hoverAtt } : null;
    const prev = prevB ? applyBuild(base, prevB) : null;
    const slotBtn = (s: AttSlot) => {
      const o = options(wid, base, s);
      const a = attById(s, b[s]);
      const changed = b[s] !== defaultAtt(wid, s);
      return o.length
        ? `<button class="lo-slot ${s === att ? 'on' : ''} ${changed ? 'mod' : ''}" data-att="${s}"><small>${SLOT_LABEL[s]}</small><b>${a?.name ?? '—'}</b></button>`
        : `<div class="lo-slot locked" title="${esc(lockReason(wid, s))}"><small>${SLOT_LABEL[s]}</small><b>${esc(lockReason(wid, s))}</b></div>`;
    };
    const opt = (a: Attachment) => {
      const on = b[att] === a.id;
      const pc = prosCons(a);
      const isDefault = a.id === defaultAtt(wid, att);
      return `<button class="lo-opt ${on ? 'on' : ''}" data-opt="${a.id}">
        <div class="lo-optt"><b>${a.name}</b>${on ? `<i class="lo-eq">${icon('check')}Fitted</i>` : isDefault ? '<i class="lo-def">Factory</i>' : ''}</div>
        <p>${a.desc}</p>
        ${pc.pro.length || pc.con.length ? `<ul>${pc.pro.map((t) => `<li class="g">${t}</li>`).join('')}${pc.con.map((t) => `<li class="r">${t}</li>`).join('')}</ul>` : ''}
      </button>`;
    };
    const n = buildCount(wid, b);
    return `<div class="lo-body smith">
      <aside class="lo-side">${ATT_SLOTS.map(slotBtn).join('')}
        <button class="lo-reset" data-a="reset" ${n ? '' : 'disabled'}>Reset to factory</button>
        <p class="lo-tip">${n}/5 slots changed. Hover a part to preview it, click to fit it.</p></aside>
      <div class="lo-mid">${stage(SLOT_LABEL[att], base.name, n ? `${n} attachment${n > 1 ? 's' : ''}` : 'Factory build')}
        <div class="lo-statstrip"><div class="lo-bars">${bars(prev ?? cur, prev ? cur : null)}</div>${numRow(prev ?? cur, prev ? cur : null)}<div class="lo-zoom">Optic zoom <b>${zoomLabel((prev ?? cur).adsZoom)}</b>${(prev ?? cur).sound.suppressed ? ' · <b>Suppressed</b>' : ''}</div></div></div>
      <section class="lo-panel opts"><div class="lo-h">${SLOT_LABEL[att]} · ${opts.length} options</div>${opts.map(opt).join('')}</section>
    </div>`;
  };

  const equip = (slot: 't' | 'l') => {
    const items = slot === 't' ? TACTICALS : LETHALS;
    const cur = slot === 't' ? ui.tactical : ui.lethal;
    return `<div class="lo-body equip">
      <div class="lo-grid">${items.map((it) => `<button class="lo-ecard ${it.id === cur ? 'on' : ''}" data-item="${it.id}">${it.id === cur ? `<i class="lo-eq">${icon('check')}Equipped</i>` : ''}<span class="lo-ebig">${icon(it.id, 'big')}</span><b>${it.name.toLowerCase()}</b><small>×${it.count} per life · ${slot === 't' ? 'key T' : 'key G'}</small><p>${it.desc}</p></button>`).join('')}</div>
    </div>`;
  };

  // ------------------------------------------------------------------ render + wiring
  const mountPreview = (id: WeaponId, b: Build | undefined) => {
    const v = el.querySelector('.lo-bench') as HTMLElement | null;
    if (v && ui.preview) ui.preview.show(v, id, b);
    else ui.preview?.stop();
  };

  function render() {
    const l = top();
    const body = l.k === 'home' ? home() : l.k === 'weapon' ? weapon(l.slot) : l.k === 'smith' ? smith(l.slot, l.att) : equip(l.slot);
    el.innerHTML = `<div class="lo">${header()}${body}</div>`;
    // the gun on the bench
    if (l.k === 'home') mountPreview(ui.primary, buildOf('p'));
    else if (l.k === 'weapon') mountPreview(focusW!, focusW === gunOf(l.slot) ? buildOf(l.slot) : undefined);
    else if (l.k === 'smith') mountPreview(gunOf(l.slot), hoverAtt ? { ...buildOf(l.slot), [l.att]: hoverAtt } : buildOf(l.slot));
    else ui.preview?.stop();
    wire();
  }

  function wire() {
    const l = top();
    const q = (s: string) => el.querySelectorAll(s) as NodeListOf<HTMLElement>;
    q('[data-a=up]').forEach((b) => b.addEventListener('click', up));
    q('[data-a=done]').forEach((b) => b.addEventListener('click', close));
    q('[data-preset]').forEach((b) => b.addEventListener('click', (e) => {
      const i = +b.dataset.preset!;
      if ((e.target as HTMLElement).closest('[data-a=rename]')) {
        renaming = true;
        render();
        const inp = el.querySelector('.lo-rename') as HTMLInputElement | null;
        inp?.focus();
        inp?.select();
        return;
      }
      if (i === ui.activePreset) return;
      ui.selectPreset(i);
      ui.sfx('uiHover', 0.6);
      render();
    }));
    const inp = el.querySelector('.lo-rename') as HTMLInputElement | null;
    if (inp) {
      const commit = () => {
        if (!renaming) return;
        renaming = false;
        const n = inp.value.trim().toUpperCase().slice(0, 16);
        if (n) ui.presets[ui.activePreset].name = n;
        ui.commitLoadout();
        render();
      };
      inp.addEventListener('keydown', (e) => {
        if (e.code === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          commit();
        }
      });
      inp.addEventListener('blur', commit);
    }
    q('[data-go]').forEach((b) => b.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-smith]')) return;
      e.stopPropagation();
      focusW = null;
      catSel = null;
      go({ k: 'weapon', slot: b.dataset.go as 'p' | 's' });
    }));
    q('[data-smith]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const slot = b.dataset.smith as 'p' | 's';
      go({ k: 'smith', slot, att: firstSlot(slot) });
    }));
    q('[data-eq]').forEach((b) => b.addEventListener('click', () => go({ k: 'equip', slot: b.dataset.eq as 't' | 'l' })));
    // weapon picker
    q('[data-cat]').forEach((b) => b.addEventListener('click', () => {
      catSel = b.dataset.cat as WeaponDef['cls'];
      focusW = null;
      ui.sfx('uiHover', 0.6);
      render();
    }));
    q('[data-w]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.dataset.w as WeaponId;
        if (focusW === id) return;
        focusW = id;
        ui.sfx('uiHover', 0.6);
        render();
      });
      b.addEventListener('dblclick', () => {
        if (l.k !== 'weapon') return;
        equipGun(l.slot, b.dataset.w as WeaponId);
        up();
      });
    });
    el.querySelector('[data-a=equip]')?.addEventListener('click', () => {
      if (l.k !== 'weapon' || !focusW) return;
      equipGun(l.slot, focusW);
      up();
    });
    el.querySelector('[data-a=equipsmith]')?.addEventListener('click', () => {
      if (l.k !== 'weapon' || !focusW) return;
      equipGun(l.slot, focusW);
      stack.pop();
      go({ k: 'smith', slot: l.slot, att: firstSlot(l.slot) });
    });
    // gunsmith
    q('[data-att]').forEach((b) => b.addEventListener('click', () => {
      if (l.k !== 'smith') return;
      stack[stack.length - 1] = { k: 'smith', slot: l.slot, att: b.dataset.att as AttSlot };
      hoverAtt = null;
      ui.sfx('uiHover', 0.6);
      render();
    }));
    q('[data-opt]').forEach((b) => {
      b.addEventListener('mouseenter', () => {
        if (l.k !== 'smith') return;
        const id = b.dataset.opt!;
        if (hoverAtt === id || buildOf(l.slot)[l.att] === id) return;
        hoverAtt = id;
        refreshSmith(l.slot, l.att);
      });
      b.addEventListener('click', () => {
        if (l.k !== 'smith') return;
        setBuild(l.slot, { ...buildOf(l.slot), [l.att]: b.dataset.opt! });
        hoverAtt = null;
        ui.sfx('uiConfirm', 0.55);
        render();
      });
    });
    el.querySelector('.lo-panel.opts')?.addEventListener('mouseleave', () => {
      if (l.k !== 'smith' || !hoverAtt) return;
      hoverAtt = null;
      refreshSmith(l.slot, l.att);
    });
    el.querySelector('[data-a=reset]')?.addEventListener('click', () => {
      if (l.k !== 'smith') return;
      setBuild(l.slot, {});
      ui.sfx('uiBack', 0.55);
      render();
    });
    // tactical / lethal
    q('[data-item]').forEach((b) => b.addEventListener('click', () => {
      if (l.k !== 'equip') return;
      if (l.slot === 't') ui.tactical = b.dataset.item as TacticalId;
      else ui.lethal = b.dataset.item as LethalId;
      ui.commitLoadout();
      ui.sfx('uiConfirm', 0.55);
      up();
    }));
  }

  /** gunsmith hover: refresh the bars, numbers and the gun without rebuilding the option list */
  function refreshSmith(slot: 'p' | 's', att: AttSlot) {
    const wid = gunOf(slot);
    const base = WEAPONS[wid];
    const b = buildOf(slot);
    const cur = applyBuild(base, b);
    const prev = hoverAtt ? applyBuild(base, { ...b, [att]: hoverAtt }) : null;
    const strip = el.querySelector('.lo-statstrip');
    if (strip) strip.innerHTML = `<div class="lo-bars">${bars(prev ?? cur, prev ? cur : null)}</div>${numRow(prev ?? cur, prev ? cur : null)}<div class="lo-zoom">Optic zoom <b>${zoomLabel((prev ?? cur).adsZoom)}</b>${(prev ?? cur).sound.suppressed ? ' · <b>Suppressed</b>' : ''}</div>`;
    mountPreview(wid, hoverAtt ? { ...b, [att]: hoverAtt } : b);
  }
  function firstSlot(slot: 'p' | 's'): AttSlot {
    const wid = gunOf(slot);
    return ATT_SLOTS.find((s) => options(wid, WEAPONS[wid], s).length) ?? 'optic';
  }
  function equipGun(slot: 'p' | 's', id: WeaponId) {
    if (slot === 'p') {
      if (ui.primary !== id) ui.primaryBuild = {};
      ui.primary = id;
    } else {
      if (ui.secondary !== id) ui.secondaryBuild = {};
      ui.secondary = id;
    }
    ui.commitLoadout();
    ui.sfx('uiConfirm', 0.6);
  }

  el.classList.remove('hidden');
  render();
}
