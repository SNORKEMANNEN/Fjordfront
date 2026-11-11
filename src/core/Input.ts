/** Keyboard/mouse input with pointer lock and per-frame edge detection. */
export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'crouch' | 'prone' | 'sprint'
  | 'reload' | 'inspect' | 'primary' | 'secondary' | 'swap' | 'melee' | 'scoreboard' | 'fire' | 'ads' | 'fireMode' | 'spot' | 'tuning' | 'grenade' | 'tactical' | 'streak1' | 'streak2' | 'streak3' | 'nvg' | 'ping' | 'map' | 'leanL' | 'leanR' | 'field';

const BINDS: Record<string, Action> = {
  KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  Space: 'jump', KeyC: 'crouch', ControlLeft: 'crouch', KeyZ: 'prone',
  ShiftLeft: 'sprint', KeyR: 'reload', KeyI: 'inspect',
  Digit1: 'primary', Digit2: 'secondary', KeyQ: 'leanL', KeyE: 'leanR', KeyV: 'melee', KeyX: 'ping', Tab: 'scoreboard', KeyB: 'fireMode', KeyF: 'spot', Backquote: 'tuning', F2: 'tuning',
  KeyG: 'grenade', KeyT: 'tactical', KeyH: 'field', KeyN: 'nvg', KeyM: 'map', Digit3: 'streak1', Digit4: 'streak2', Digit5: 'streak3',
};

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

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab') e.preventDefault();
      if (this.typing) return;
      const a = BINDS[e.code];
      if (!a || e.repeat) return;
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
      if (e.button === 0) this.press('fire');
      if (e.button === 2) this.press('ads');
      if (e.button === 1) this.press('ping');
      if (e.button === 4) this.press('reload');
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.release('fire');
      if (e.button === 2) this.release('ads');
      if (e.button === 1) this.release('ping');
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Guard against browser pointer-lock spikes
      if (Math.abs(e.movementX) > 600 || Math.abs(e.movementY) > 600) return;
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
    return (this.isDown(pos) ? 1 : 0) - (this.isDown(neg) ? 1 : 0);
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}
