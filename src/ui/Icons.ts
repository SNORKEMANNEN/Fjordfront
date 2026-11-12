/**
 * Fjordfront icon set (Update 29, "Sjøkart"): one family drawn for this game on a 24×24 grid —
 * 1.75 px ink strokes, round caps and joins, light 18 % tint fills for solid parts, the way a chart
 * draughtsman inks symbols. Everything is currentColor, so the same icon reads in navy ink on the
 * paper menus and in white on the HUD.
 */
const S = (body: string, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const T = 'fill="currentColor" fill-opacity=".18"';
const F = 'fill="currentColor" stroke="none"';

export const ICONS: Record<string, string> = {
  // ---------------------------------------------------------------- lethal
  frag: S(`<path d="M9 7.5h6l1.5 2.5v7a4.5 4.5 0 0 1-4.5 4.5A4.5 4.5 0 0 1 7.5 17v-7z" ${T}/><path d="M7.6 13h8.8M12 10v11"/><path d="M10 7.5V5h4v2.5"/><path d="M14 5.5c2.5 0 4 1.3 4.3 3.6v3.4"/><circle cx="7.8" cy="4.4" r="1.7"/>`),
  sticky: S(`<rect x="7.5" y="6.5" width="9" height="11" rx="2.5" ${T}/><path d="M7.5 11h9"/><path d="M10 6.5V4h4v2.5"/><path d="M6 20c4 1.6 8 1.6 12 0" stroke-width="2.4"/><circle cx="12" cy="14.2" r="1.1" ${F}/>`),
  claymore: S(`<path d="M4 8.5c5.3-2 10.7-2 16 0v5c-5.3-2-10.7-2-16 0z" ${T}/><path d="M7 13l-1.5 6M17 13l1.5 6M9.5 12.5l.6 6.5M14.5 12.5l-.6 6.5"/><path d="M8 9.5h8" stroke-dasharray="1.2 1.6"/>`),
  c4: S(`<rect x="3.5" y="10" width="17" height="8.5" rx="1" ${T}/><path d="M9 10v8.5M15 10v8.5"/><rect x="9.5" y="6.5" width="5" height="3.5" rx=".6"/><path d="M10.5 6.5 8.5 2.8"/><circle cx="13" cy="8.2" r=".7" ${F}/>`),
  tknife: S(`<path d="M5 19 16.5 7.5l3.5-2.5-2.5 3.5L6 20z" ${T}/><path d="M8.6 15.4l2 2"/><circle cx="4.3" cy="19.7" r="1.5"/>`),
  // ---------------------------------------------------------------- tactical
  flash: S(`<rect x="7" y="7.5" width="7.5" height="13" rx="1.6" ${T}/><path d="M7 11h7.5M7 17h7.5"/><circle cx="9.5" cy="14" r=".7" ${F}/><circle cx="12" cy="14" r=".7" ${F}/><path d="M8.8 7.5V5.2h4V7.5"/><path d="M18 3.5l-1.2 2.6M21 7l-2.8.8M20.6 11.4l-2.5-.9"/>`),
  stun: S(`<rect x="8.2" y="8.5" width="7.6" height="12" rx="3.8" ${T}/><path d="M8.2 14.5h7.6"/><path d="M10.3 8.5V6h3.4v2.5"/><path d="M4.6 11.5a7.5 7.5 0 0 0 0 6.5M2.4 9.5a10.5 10.5 0 0 0 0 10.5M19.4 11.5a7.5 7.5 0 0 1 0 6.5M21.6 9.5a10.5 10.5 0 0 1 0 10.5"/>`),
  smoke: S(`<rect x="4.5" y="10.5" width="6.5" height="10" rx="1.4" ${T}/><path d="M4.5 13.5h6.5"/><path d="M6 10.5V8.3h3.5v2.2"/><path d="M13 11a3 3 0 0 1 5.5-1.7 2.6 2.6 0 0 1 3.2 3.1 2.5 2.5 0 0 1-1.4 4.6H14.2A2.4 2.4 0 0 1 13 11z" ${T}/><path d="M14.5 5.5a2.2 2.2 0 0 1 3.9.3"/>`),
  stim: S(`<g transform="rotate(-40 12 12)"><rect x="4" y="9.3" width="12" height="5.4" rx="1.5" ${T}/><path d="M16 12h3.5M19.5 10.3v3.4M4 12H2.5"/><path d="M8.5 10.6v2.8M7.1 12h2.8"/></g>`),
  snapshot: S(`<rect x="8" y="12" width="8" height="6.5" rx="1.6" ${T}/><path d="M8 15.2h8"/><path d="M5 11a8 8 0 0 1 14 0M2.4 8.8a11.6 11.6 0 0 1 19.2 0" stroke-dasharray="2.2 1.8"/><circle cx="12" cy="15.2" r=".8" ${F}/>`),
  decoy: S(`<rect x="4.5" y="7" width="7" height="13.5" rx="1.5" ${T}/><path d="M4.5 11h7M4.5 13.5h7M4.5 16h7"/><path d="M14.8 10.5a4 4 0 0 1 0 6.5M17.4 8.2a7.4 7.4 0 0 1 0 11M20 6a10.6 10.6 0 0 1 0 15.5"/>`),
  trophy: S(`<path d="M7.5 8.5h9l-1 4h-7z" ${T}/><path d="M12 12.5v3M12 15.5l-6 5M12 15.5l6 5M12 15.5v5"/><path d="M10 8.5V6.5h4v2"/><path d="M4.6 6a9 9 0 0 1 3-3M19.4 6a9 9 0 0 0-3-3"/>`),
  // ---------------------------------------------------------------- killstreaks
  uav: S(`<path d="M12 11.5 3.5 8.5M12 11.5l8.5-3M12 11.5v6"/><circle cx="12" cy="11.5" r="2.1" ${T}/><path d="M2.5 8.5h3M18.5 8.5h3"/><path d="M6.5 19.5a7.5 7.5 0 0 0 11 0" stroke-dasharray="2 2"/>`),
  mortar: S(`<path d="M6.5 20.5 14 7.5"/><rect x="12.4" y="2.6" width="4.6" height="8" rx="1" transform="rotate(30 14.7 6.6)" ${T}/><path d="M4 20.5h9M16.5 20.5l-3.2-5.3"/>`),
  heli: S(`<path d="M2.5 5h19M12 5v3"/><path d="M5 12.5c0-2.6 2.6-4.5 6-4.5h2.6C16.3 8 18 10 18 12.5S16.3 16 13.6 16H9" ${T}/><path d="M18 12.5h3.6M21.6 10.4v4.2M8 19.5h8M10 16v3.5M14 16v3.5"/>`),
  // ---------------------------------------------------------------- roles (scoreboard, squad)
  rifleman: S(`<path d="M3 13.5h12l2-2h4.5v2.5H17l-1.5 1.5H11l-1.5 3.5H7l1-3.5H3z" ${T}/><path d="M17 11.5V10"/>`),
  cqb: S(`<path d="M5 9.5h11v3h-3l-1 5H9.5l.8-5H5z" ${T}/><path d="M16 10.5h3.5M12 12.5l-.8 2"/><path d="M7.5 9.5V8"/>`),
  breacher: S(`<path d="M2.5 11h13l1.5 1h4.5v2H17l-2 1.5h-4l-1.2 3H7.5l1-3h-6z" ${T}/><path d="M6 11V9.5h3V11"/><circle cx="20" cy="7" r="2"/>`),
  sniper: S(`<path d="M2 13.5h13l2-1h5v2h-5l-2 1H9.5l-1.5 3H6l1-3H2z" ${T}/><rect x="8" y="9" width="6.5" height="2.6" rx="1.3"/><path d="M9.5 11.6v1.9M13 11.6v1.9"/>`),
  marksman: S(`<path d="M2.5 13.5h12.5l1.8-1.5h4.7v2.3h-4.5l-1.5 1.4H10l-1.3 3.3H6.5l1-3.3h-5z" ${T}/><rect x="8.5" y="9.6" width="5" height="2.2" rx="1.1"/>`),
  gunner: S(`<path d="M2 12.5h14l1.5-1h4.5v2.5h-4.5L16 15h-4.5l-1 3.5H8l1-3.5H2z" ${T}/><path d="M17.5 14 15.5 20M19 14l2 6"/><rect x="9" y="15" width="4" height="3" rx=".5"/>`),
  // ---------------------------------------------------------------- kill feed glyphs
  headshot: S(`<circle cx="12" cy="10" r="6.5" ${T}/><path d="M9 20.5v-3.2M15 20.5v-3.2M9 17.3h6"/><circle cx="12" cy="10" r="2.3"/><path d="M12 2v3M12 15v1.5M3.5 10h3M17.5 10h3"/>`),
  wallbang: S(`<path d="M9 3v18M15 3v18" ${T}/><path d="M9 7.5h6M9 12h6M9 16.5h6"/><path d="M2 12h20M19 9l3 3-3 3"/>`),
  melee: S(`<path d="M3.5 20.5l6-6M9.5 14.5l2 2M11.5 16.5l8.5-11.5-11.5 8.5z" ${T}/>`),
  explosion: S(`<path d="M12 2.5l1.8 5.2 5.2-2.6-2.6 5.2 5.1 1.7-5.1 1.8 2.6 5.2-5.2-2.6-1.8 5.1-1.8-5.1-5.2 2.6 2.6-5.2L2.5 12l5.1-1.7L5 5.1l5.2 2.6z" ${T}/>`),
  fire: S(`<path d="M12 21.5c-3.9 0-6.5-2.6-6.5-6.2 0-3.6 2.8-5.4 3.6-9.3 1.9 1.6 2.6 3.4 2.7 5 1.1-.8 1.7-2.4 1.7-4 2.6 2.1 5 5.1 5 8.3 0 3.6-2.6 6.2-6.5 6.2z" ${T}/>`),
  fall: S(`<path d="M12 3v13M7 11.5l5 5 5-5"/><path d="M4 20.5h16"/>`),
  // ---------------------------------------------------------------- comms / scoreboard
  mic: S(`<rect x="9" y="3" width="6" height="11" rx="3" ${T}/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3.5M8.5 21h7"/>`),
  speaker: S(`<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" ${T}/><path d="M15 9a4 4 0 0 1 0 6M17.6 6.5a7.6 7.6 0 0 1 0 11"/>`),
  muted: S(`<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" ${T}/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>`),
  report: S(`<path d="M5 21V3.5"/><path d="M5 4h12l-2.5 4 2.5 4H5" ${T}/>`),
  bot: S(`<rect x="5" y="8" width="14" height="10.5" rx="2.5" ${T}/><circle cx="9.5" cy="13" r="1.2" ${F}/><circle cx="14.5" cy="13" r="1.2" ${F}/><path d="M12 8V5M10.5 4.5h3M3 12v3M21 12v3"/>`),
  host: S(`<path d="M3 18.5h18M5 18.5l-1.5-10 5 4 3.5-6.5 3.5 6.5 5-4-1.5 10" ${T}/>`),
  // ---------------------------------------------------------------- map markers
  ping: S(`<path d="M12 3l7 9-7 9-7-9z" ${T}/><circle cx="12" cy="12" r="1.6" ${F}/>`),
  waypoint: S(`<path d="M6 21V3.5"/><path d="M6 4h11.5l-2.5 3.8 2.5 3.7H6" ${T}/>`),
  squad: S(`<path d="M12 4l7 15-7-4-7 4z" ${T}/>`),
  objective: S(`<circle cx="12" cy="12" r="8.5" ${T}/><circle cx="12" cy="12" r="3"/>`),
  compass: S(`<circle cx="12" cy="12" r="9"/><path d="M12 4.5l2.2 7.5L12 19.5 9.8 12z" ${T}/><path d="M12 4.5l2.2 7.5H9.8z" ${F}/>`),
  // ---------------------------------------------------------------- menu rail / modes
  play: S(`<circle cx="12" cy="12" r="9" ${T}/><path d="M10 8.2l6 3.8-6 3.8z" ${F}/>`),
  loadout: S(`<path d="M2.5 12.5h12.5l2-2h4.5V13H17l-1.5 1.5H10.5L9.3 18H6.8l1.1-3.5H2.5z" ${T}/><path d="M6 8.5h4M6 6h7"/>`),
  settings: S(`<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/><circle cx="12" cy="12" r="6.5" ${T}/>`),
  manual: S(`<path d="M4 4.5h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4zM20 4.5h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z" ${T}/><path d="M6.5 8.5h3M6.5 11.5h3M14.5 8.5h3M14.5 11.5h3"/>`),
  news: S(`<rect x="3.5" y="4.5" width="17" height="15" rx="1.5" ${T}/><path d="M7 8.5h10M7 12h4.5M7 15.5h4.5M14 12h3v3.5h-3z"/>`),
  domination: S(`<path d="M5 21V4M5 4.5h7.5l-1.8 3 1.8 3H5" ${T}/><path d="M14 21v-8M14 13.5h6l-1.4 2.2 1.4 2.3h-6"/>`),
  multiplayer: S(`<circle cx="8.5" cy="8" r="3" ${T}/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M3 19.5c.5-3.6 2.7-5.5 5.5-5.5s5 1.9 5.5 5.5M14.5 14.6c.6-.4 1.3-.6 2-.6 2.3 0 4 1.6 4.5 4.6"/>`),
  quick: S(`<path d="M13.5 2.5 5 13.5h6l-1 8 8.5-11h-6z" ${T}/>`),
  exit: S(`<path d="M10 4.5H5v15h5"/><path d="M14 8l4 4-4 4M18 12H9"/>`),
  // ---------------------------------------------------------------- fire modes
  fm_auto: S(`<rect x="4" y="7" width="3.4" height="10" rx="1.7" ${T}/><rect x="10.3" y="7" width="3.4" height="10" rx="1.7" ${T}/><rect x="16.6" y="7" width="3.4" height="10" rx="1.7" ${T}/>`),
  fm_burst: S(`<rect x="6" y="7" width="3" height="10" rx="1.5" ${T}/><rect x="10.5" y="7" width="3" height="10" rx="1.5" ${T}/><rect x="15" y="7" width="3" height="10" rx="1.5" ${T}/><path d="M5 20h14"/>`),
  fm_semi: S(`<rect x="10.3" y="7" width="3.4" height="10" rx="1.7" ${T}/>`),
  fm_bolt: S(`<rect x="10.3" y="8" width="3.4" height="10" rx="1.7" ${T}/><path d="M7 5h6.5M11 3l2.5 2-2.5 2"/>`),
  fm_pump: S(`<rect x="9.5" y="8" width="5" height="10" rx="1.2" ${T}/><path d="M6 5h12M6 5l2-2M18 5l-2-2"/>`),
  // ---------------------------------------------------------------- misc
  boat: S(`<path d="M3 14.5h18l-2.8 4.5H5.8z" ${T}/><path d="M7 14.5v-4h6l2 4M11 10.5v-4M11 6.5h3.5"/><path d="M2 21c1.5-.8 3-.8 4.5 0s3 .8 4.5 0 3-.8 4.5 0 3 .8 4.5 0"/>`),
  anchor: S(`<circle cx="12" cy="5" r="2"/><path d="M12 7v13.5M8 10.5h8"/><path d="M4.5 13.5c0 4 3.4 7 7.5 7s7.5-3 7.5-7M3 15l1.5-1.5L6 15M18 15l1.5-1.5L21 15"/>`),
  check: S(`<path d="M5 12.5l4.5 4.5L19 7.5"/>`),
  close: S(`<path d="M6 6l12 12M18 6 6 18"/>`),
  chevron: S(`<path d="M9 5l7 7-7 7"/>`),
  lock: S(`<rect x="5.5" y="10.5" width="13" height="10" rx="1.5" ${T}/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>`),
  signal: S(`<path d="M5 19v-3M10 19v-6M15 19v-9M20 19V6"/>`),
};

export function icon(name: string, cls = '') {
  return `<i class="ico ${cls}">${ICONS[name] ?? ''}</i>`;
}

/**
 * Faction emblems, drawn for the game.
 *  - Kystjegerne (coast rangers): a fouled anchor inside a rope ring, a gull gliding over it.
 *  - Nordfront: a raven with spread wings over three mountain peaks, in a cut-corner shield.
 */
export const EMBLEMS: Record<0 | 1, string> = {
  0: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="32" cy="34" r="27" fill="currentColor" fill-opacity=".1"/>
    <circle cx="32" cy="34" r="27" stroke-dasharray="3.2 2.6"/>
    <circle cx="32" cy="34" r="22.5" stroke-width="1.4"/>
    <path d="M14.5 15.5c3.6-3.2 7.4-3.8 10.6-.2 1.9-1.9 3.6-2.3 6.9-1.3 3.3-1 5-.6 6.9 1.3 3.2-3.6 7-3 10.6.2" stroke-width="2.6"/>
    <circle cx="32" cy="22.5" r="3"/>
    <path d="M32 25.5v26M24.5 30h15"/>
    <path d="M19.5 41c1.5 7 6.5 11 12.5 11s11-4 12.5-11"/>
    <path d="M17 43.5l2.5-3 3 2.5M47 43.5l-2.5-3-3 2.5"/>
    <path d="M28 36c4-3.5 8 2 4 5s-4 7 1 8" stroke-width="1.5"/>
  </svg>`,
  1: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 6h44l4 6v26c0 12-11 19.5-26 24C17 57.5 6 50 6 38V12z" fill="currentColor" fill-opacity=".1"/>
    <path d="M10 6h44l4 6v26c0 12-11 19.5-26 24C17 57.5 6 50 6 38V12z"/>
    <path d="M9 47l11-15 6.5 8L35 27l9 12.5 4-5 7.5 11" stroke-width="2"/>
    <path d="M30.5 32.8l4.5-5.8 4 5.5" fill="currentColor" fill-opacity=".35" stroke-width="1.4"/>
    <path d="M32 26c-2.5-1.5-6-1.4-9.5-3.8-3.4-2.3-6.6-6.2-9.5-6.2 2.4 2.6 3.4 4.8 6.5 6.6-2.8 0-5.3-.8-7.5-2.3 2.4 3.4 6.4 5.4 11 6 2.8.4 5.8.6 9 0z" fill="currentColor" fill-opacity=".85" stroke-width="1.2"/>
    <path d="M32 26c2.5-1.5 6-1.4 9.5-3.8 3.4-2.3 6.6-6.2 9.5-6.2-2.4 2.6-3.4 4.8-6.5 6.6 2.8 0 5.3-.8 7.5-2.3-2.4 3.4-6.4 5.4-11 6-2.8.4-5.8.6-9 0z" fill="currentColor" fill-opacity=".85" stroke-width="1.2"/>
    <path d="M32 18.5c1.8 0 3 1.3 3 3.2 0 1.4-.8 2.4-1.6 3.4l-1.4 3-1.4-3c-.8-1-1.6-2-1.6-3.4 0-1.9 1.2-3.2 3-3.2z" fill="currentColor" stroke-width="1.2"/>
    <path d="M33 19.8l3.4.9-3 .9" fill="currentColor" stroke-width="1"/>
    <path d="M30.5 28.5l-1.8 3.2M33.5 28.5l1.8 3.2" stroke-width="1.6"/>
  </svg>`,
};
export function emblem(team: number, cls = '') {
  return `<i class="emblem ${cls}">${EMBLEMS[(team === 1 ? 1 : 0) as 0 | 1]}</i>`;
}
