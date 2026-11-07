/**
 * Small on-screen error report. A JS error inside the game loop used to freeze the frame
 * forever (it looked like a crash). Now the loop survives, and the first error of each kind is
 * shown bottom-left with its stack top, so it can be screenshotted and fixed.
 */
const seen = new Set<string>();
let box: HTMLDivElement | null = null;
let hideT = 0;

export function reportError(where: string, e: unknown) {
  const err = e instanceof Error ? e : new Error(String(e));
  const key = where + ':' + err.message;
  console.error(`[${where}]`, err);
  if (seen.has(key)) return;
  seen.add(key);
  if (!box) {
    box = document.createElement('div');
    box.className = 'errreport';
    document.body.appendChild(box);
  }
  const top = (err.stack || '').split('\n').slice(1, 4).map((l) => l.trim().replace(/\(?https?:\/\/[^/]+\//, '(')).join('<br>');
  box.innerHTML = `<b>Recovered from an error (${where})</b><div>${err.message}</div><small>${top}</small>`;
  box.style.display = 'block';
  clearTimeout(hideT);
  hideT = window.setTimeout(() => box && (box.style.display = 'none'), 12000);
}

export function installErrorReport() {
  window.addEventListener('error', (ev) => reportError('script', ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', (ev) => reportError('promise', ev.reason));
}
