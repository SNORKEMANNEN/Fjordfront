/**
 * HUD / menu icons as inline SVG (24×24 viewBox, currentColor), drawn for this game.
 */
const S = (body: string, vb = '0 0 24 24') => `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS: Record<string, string> = {
  // frag: segmented body, fuse head, spoon and pull ring
  frag: S(`<ellipse cx="11" cy="14.5" rx="6.2" ry="7" fill="currentColor" fill-opacity=".22"/><path d="M5.2 12.2h11.6M5.2 16.8h11.6M11 7.5v14"/><rect x="8.6" y="4.3" width="4.8" height="3.4" rx=".8" fill="currentColor" fill-opacity=".5"/><path d="M13.4 5.2c3 0 4.8 1.6 5.3 4.4l-.2 4.6"/><circle cx="7.2" cy="4.2" r="2.1"/>`),
  // flashbang: perforated cylinder with a bright burst
  flash: S(`<rect x="7.5" y="7" width="7.5" height="14" rx="1.6" fill="currentColor" fill-opacity=".2"/><path d="M7.5 10.5h7.5M7.5 17.5h7.5"/><circle cx="9.8" cy="14" r=".6" fill="currentColor"/><circle cx="12.7" cy="14" r=".6" fill="currentColor"/><rect x="9.2" y="4.3" width="4.2" height="2.7" rx=".6"/><path d="M18.5 3.5l-1.4 2.6M21 7.5l-2.8.6M20.6 11.6l-2.4-1"/>`),
  // smoke: canister with rolling puffs
  smoke: S(`<rect x="4.5" y="10" width="6.5" height="11" rx="1.4" fill="currentColor" fill-opacity=".2"/><path d="M4.5 13h6.5"/><rect x="5.8" y="7.6" width="3.9" height="2.4" rx=".6"/><path d="M12.5 10.5a3 3 0 0 1 5.6-1.6 2.6 2.6 0 0 1 3.3 3.3 2.6 2.6 0 0 1-1.4 4.8h-6.2a2.4 2.4 0 0 1-1.3-6.5z" fill="currentColor" fill-opacity=".25"/><path d="M14.5 5.2a2.2 2.2 0 0 1 3.8.4"/>`),
  // stun / concussion: grenade with shock rings
  stun: S(`<rect x="8" y="9" width="7" height="12" rx="3.5" fill="currentColor" fill-opacity=".22"/><path d="M8 15h7"/><rect x="9.8" y="6.3" width="3.4" height="2.7" rx=".6"/><path d="M4.2 11.5a8 8 0 0 0 0 7M2 9.5a11 11 0 0 0 0 11M18.8 11.5a8 8 0 0 1 0 7M21 9.5a11 11 0 0 1 0 11"/>`),
  // stim: auto-injector with a plus
  stim: S(`<rect x="3.5" y="9.3" width="12.5" height="5.4" rx="1.6" fill="currentColor" fill-opacity=".22" transform="rotate(-40 9.7 12)"/><path d="M14.6 6.8l2.6 2.6M16.4 5l2.6 2.6M18.6 7.6l1.6-1.6M4.8 19.2l-1.8 1.8"/><path d="M8.2 11.2v3.6M6.4 13h3.6" transform="rotate(-40 8.2 13)"/>`),
  // throwing knife: slim one-piece blade with a ring pommel, tilted for the throw
  tknife: S(`<path d="M5.5 18.5l10.8-10.8 3.4-2.4-2.4 3.4L6.5 19.5z" fill="currentColor" fill-opacity=".25"/><path d="M8.8 15.2l2 2"/><circle cx="4.6" cy="19.4" r="1.6"/>`),
  // combat knife
  knife: S(`<path d="M3.5 20.5l6-6M9.5 14.5l2 2M11.5 16.5l8.5-11.5-11.5 8.5z" fill="currentColor" fill-opacity=".25"/>`),
  uav: S(`<path d="M12 12l-7.5-3.5M12 12l7.5-3.5M12 12v7"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M3 8.5h3M18 8.5h3"/><path d="M7 19.5a7 7 0 0 0 10 0" stroke-dasharray="2 2"/>`),
  mortar: S(`<path d="M7 20l7-12"/><rect x="12.5" y="3" width="4.5" height="8" rx="1" transform="rotate(30 14.7 7)" fill="currentColor" fill-opacity=".22"/><path d="M4.5 20.5h9M16 20l-3-5"/>`),
  heli: S(`<path d="M3 5h18M12 5v3"/><path d="M5 12.5c0-2.5 2.5-4.5 6-4.5h2.5c2.5 0 4.5 2 4.5 4.5s-2 3.5-4.5 3.5H9" fill="currentColor" fill-opacity=".22"/><path d="M18 12.5h3.5M21.5 10.5v4M8 19h8M10 16v3M14 16v3"/>`),
};

export function icon(name: string, cls = '') {
  return `<i class="ico ${cls}">${ICONS[name] ?? ''}</i>`;
}
