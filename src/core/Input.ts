import { Settings } from '../game/Settings';

/** Keyboard/mouse/controller input with pointer lock, rebindable keys and per-frame edge detection. */
export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'crouch' | 'prone' | 'sprint'
  | 'reload' | 'inspect' | 'primary' | 'secondary' | 'swap' | 'melee' | 'scoreboard' | 'fire' | 'ads' | 'fireMode' | 'spot' | 'tuning' | 'grenade' | 'tactical' | 'streak1' | 'streak2' | 'streak3' | 'nvg' | 'ping' | 'map' | 'leanL' | 'leanR' | 'field' | 'orders' | 'aidebug'
  | 'chatTeam' | 'talk' | 'spectate';

/** default bindings (key code or Mouse0-4 → action) */
export const DEFAULT_BINDS: Record<string, Action> = {
  KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  Space: 'jump', KeyC: 'crouch', ControlLeft: 'crouch', KeyZ: 'prone',
  ShiftLeft: 'sprint', KeyR: 'reload', KeyI: 'inspect',
  Digit1: 'primary', Digit2: 'secondary', KeyQ: 'leanL', KeyE: 'leanR', KeyV: 'melee', KeyX: 'ping', Tab: 'scoreboard', KeyB: 'fireMode', KeyF: 'spot', Backquote: 'tuning', F2: 'tuning',
  KeyG: 'grenade', KeyT: 'tactical', KeyH: 'field', KeyN: 'nvg', KeyM: 'map', KeyY: 'orders', F4: 'aidebug', Digit3: 'streak1', Digit4: 'streak2', Digit5: 'streak3',
  KeyU: 'chatTeam', KeyK: 'talk', F6: 'spectate',
  Mouse0: 'fire', Mouse2: 'ads', Mouse1: 'ping', Mouse4: 'reload',
};
/** the rebindable actions, in the order the Controls tab lists them */
export const ACTION_LABELS: [Action, string][] = [
  ['forward', 'Move forward'], ['back', 'Move back'], ['left', 'Move left'], ['right', 'Move right'],
  ['jump', 'Jump / mantle'], ['sprint', 'Sprint (double-tap: tactical sprint)'], ['crouch', 'Crouch / slide'], ['prone', 'Prone / dive'],
  ['leanL', 'Lean left'], ['leanR', 'Lean right'],
  ['fire', 'Fire'], ['ads', 'Aim down sights'], ['reload', 'Reload'], ['fireMode', 'Fire mode'], ['inspect', 'Inspect weapon'],
  ['primary', 'Primary weapon'], ['secondary', 'Sidearm'], ['melee', 'Melee / knife (hold)'],
  ['grenade', 'Lethal'], ['tactical', 'Tactical'], ['field', 'Field upgrade'],
  ['streak1', 'Killstreak 1'], ['streak2', 'Killstreak 2'], ['streak3', 'Killstreak 3'],
  ['spot', 'Use / spot'], ['ping', 'Ping'], ['nvg', 'Night vision'], ['map', 'Tactical map'], ['orders', 'Squad orders'],
  ['scoreboard', 'Scoreboard'], ['chatTeam', 'Team chat'], ['talk', 'Push to talk'], ['spectate', 'Spectate / free camera'],
];
let BINDS: Record<string, Action> = { ...DEFAULT_BINDS };
/** keys per action (defaults with the player's overrides) */
export function keysFor(a: Action): string[] {
  const o = Settings.data.keybinds?.[a];
  if (o) return o;
  return Object.keys(DEFAULT_BINDS).filter((k) => DEFAULT_BINDS[k] === a);
}
/** rebuild the key table from the settings */
export function applyKeybinds() {
  const over = Settings.data.keybinds ?? {};
  const next: Record<string, Action> = {};
  for (const [k, a] of Object.entries(DEFAULT_BINDS)) if (!over[a]) next[k] = a;
  for (const [a, keys] of Object.entries(over)) for (const k of keys) next[k] = a as Action;
  BINDS = next;
}
export function bindOf(code: string): Action | undefined {
  return BINDS[code];
}
/** a key code as a short label */
export function keyLabel(code: string) {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const m: Record<string, string> = { Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', Mouse3: 'MOUSE 4', Mouse4: 'MOUSE 5', Space: 'SPACE', ShiftLeft: 'L SHIFT', ShiftRight: 'R SHIFT', ControlLeft: 'L CTRL', ControlRight: 'R CTRL', AltLeft: 'L ALT', AltRight: 'R ALT', Backquote: '`', CapsLock: 'CAPS', Tab: 'TAB', Enter: 'ENTER', Backspace: 'BKSP' };
  return m[code] ?? code.replace('Arrow', '').replace('Numpad', 'NUM ').toUpperCase();
}

/**
 * Controller (standard mapping): left stick move, right stick look, LT aim, RT fire, A jump,
 * B crouch (hold: prone), X reload / use, Y weapon swap, LB tactical, RB lethal, L3 sprint,
 * R3 melee, d-pad: up NVG · down ping · left streak · right map, View scoreboard, Menu pause.
 */
const PAD_BUTTONS: (Action | null)[] = ['jump', 'crouch', 'reload', 'swap', 'tactical', 'grenade', 'ads', 'fire', 'scoreboard', null, 'sprint', 'melee', 'nvg', 'ping', 'streak1', 'map'];

/** what still reaches the game while the tactical map is open (you can walk, not fight) */
const MAP_PASS = new Set<Action>(['forward', 'back', 'left', 'right', 'jump', 'crouch', 'prone', 'sprint', 'map', 'scoreboard']);

export class Input {
  /** tactical map open: only movement reaches the game, the map reads everything raw */
  mapMode = false;
  /** chat box open: keys type text instead of playing */
  typing = false;
  private down = new Set<Action>();
  private pressed = new Set<Action>();
  private released = new Set<Action>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  locked = false;
  enabled = true;
  onLockChange: (locked: boolean) => void = () => {};
  private lastShift = 0;
  sprintDoubleTap = false;
  /** analog movement from a controller stick (axis() adds it to the keys) */
  private padAxis = { x: 0, y: 0 };
  private padDown = new Set<Action>();
  private padPrev: boolean[] = [];
  /** last input came from a controller (aim assist, prompts) */
  padActive = false;
  /** right stick this frame (−1..1, after deadzone + curve) for aim assist */
  padLook = { x: 0, y: 0 };
  onPadPause: () => void = () => {};
  private bHeld = 0;

  constructor(private el: HTMLElement) {
    applyKeybinds();
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab') e.preventDefault();
      if (this.typing) return;
      const a = BINDS[e.code];
      if (!a || e.repeat) return;
      this.padActive = false;
      if (a === 'sprint') {
        const now = performance.now();
        this.sprintDoubleTap = now - this.lastShift < 300;
        this.lastShift = now;
      }
      this.press(a);
    });
    window.addEventListener('keyup', (e) => {
      const a = BINDS[e.code];
      if (a) this.release(a);
    });
    window.addEventListener('blur', () => {
      for (const a of this.down) this.released.add(a);
      this.down.clear();
    });
    el.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this.padActive = false;
      const a = BINDS['Mouse' + e.button];
      if (a) this.press(a);
    });
    window.addEventListener('mouseup', (e) => {
      const a = BINDS['Mouse' + e.button];
      if (a) this.release(a);
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Guard against browser pointer-lock spikes
      if (Math.abs(e.movementX) > 600 || Math.abs(e.movementY) > 600) return;
      if (e.movementX || e.movementY) this.padActive = false;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener('wheel', (e) => {
      if (this.locked) this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) {
        for (const a of this.down) this.released.add(a);
        this.down.clear();
      }
      this.onLockChange(this.locked);
    });
  }

  private press(a: Action) {
    if (!this.down.has(a)) this.pressed.add(a);
    this.down.add(a);
  }
  private release(a: Action) {
    if (this.down.has(a)) this.released.add(a);
    this.down.delete(a);
  }

  /** Simulate input (used by automated tests). */
  simulate(a: Action, isDown: boolean) {
    isDown ? this.press(a) : this.release(a);
  }

  lock() {
    const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }
  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(a: Action) {
    return this.enabled && this.down.has(a) && (!this.mapMode || MAP_PASS.has(a));
  }
  wasPressed(a: Action) {
    return this.enabled && this.pressed.has(a) && (!this.mapMode || MAP_PASS.has(a));
  }
  rawDown(a: Action) {
    return this.enabled && this.down.has(a);
  }
  rawPressed(a: Action) {
    return this.enabled && this.pressed.has(a);
  }
  rawReleased(a: Action) {
    return this.enabled && this.released.has(a);
  }
  /** drop a held action without a release edge (e.g. the trigger still held as the map closes) */
  forget(a: Action) {
    this.down.delete(a);
    this.pressed.delete(a);
  }
  wasReleased(a: Action) {
    return this.enabled && this.released.has(a);
  }
  axis(neg: Action, pos: Action) {
    let v = (this.isDown(pos) ? 1 : 0) - (this.isDown(neg) ? 1 : 0);
    if (this.enabled && !this.typing) {
      if (neg === 'left' && pos === 'right') v += this.padAxis.x;
      else if (neg === 'back' && pos === 'forward') v += this.padAxis.y;
    }
    return Math.max(-1, Math.min(1, v));
  }

  /** read the first connected controller (call once per frame, before the game reads input) */
  pollGamepad(dt: number) {
    const pads = navigator.getGamepads?.() ?? [];
    let gp: Gamepad | null = null;
    for (const p of pads) if (p && p.connected && p.mapping === 'standard') { gp = p; break; }
    if (!gp) {
      if (this.padDown.size) for (const a of this.padDown) this.release(a);
      this.padDown.clear();
      this.padAxis.x = this.padAxis.y = 0;
      this.padLook.x = this.padLook.y = 0;
      return;
    }
    const s = Settings.data;
    const dz = s.padDeadzone;
    const stick = (x: number, y: number) => {
      const m = Math.hypot(x, y);
      if (m < dz) return [0, 0];
      const k = Math.min(1, (m - dz) / (1 - dz)) / m;
      return [x * k, y * k];
    };
    const [mx, my] = stick(gp.axes[0] ?? 0, gp.axes[1] ?? 0);
    const [lx, ly] = stick(gp.axes[2] ?? 0, gp.axes[3] ?? 0);
    if (mx || my || lx || ly) this.padActive = true;
    this.padAxis.x = mx;
    this.padAxis.y = -my;
    // look: a response curve (fine aim near the centre, fast turns at the edge) at up to ~3.6 rad/s
    const curve = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 1.8);
    this.padLook.x = curve(lx);
    this.padLook.y = curve(ly) * (s.padInvertY ? -1 : 1);
    const rate = 3.6 * s.padSensitivity;
    // expressed as mouse counts for the shared look path (which applies the mouse sensitivity, so undo it)
    const counts = (rate * dt) / (0.0022 * Math.max(0.05, s.sensitivity));
    if (!this.typing) {
      this.mouseDX += this.padLook.x * counts;
      this.mouseDY += this.padLook.y * counts;
    }
    const want = new Set<Action>();
    gp.buttons.forEach((b, i) => {
      const on = i === 6 || i === 7 ? b.value > 0.35 : b.pressed;
      if (on) this.padActive = true;
      const a = PAD_BUTTONS[i];
      if (i === 9 && on && !this.padPrev[9]) this.onPadPause();
      this.padPrev[i] = on;
      if (!a || !on) return;
      want.add(a);
    });
    // B held → prone
    if (want.has('crouch')) {
      this.bHeld += dt;
      if (this.bHeld > 0.4) {
        want.delete('crouch');
        want.add('prone');
      }
    } else this.bHeld = 0;
    // L3 is sprint; full stick forward also counts as 'forward' held (sprint needs it)
    if (this.padAxis.y > 0.5) want.add('forward');
    if (this.typing) want.clear();
    for (const a of want) if (!this.padDown.has(a)) this.press(a);
    for (const a of this.padDown) if (!want.has(a)) this.release(a);
    this.padDown = want;
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}
