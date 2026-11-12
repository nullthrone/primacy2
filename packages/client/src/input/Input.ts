/**
 * Keyboard and mouse input. Held keys become the per-tick `ShipInput`; single presses become
 * actions the game handles. Controls follow shooter conventions (see `DEFAULT_BINDINGS`).
 */
import { Button, DEFAULT_PIPS, FlightMode, addPip, type ShipInput } from '@primacy2/shared';
import { store, type BindAction } from '../state/store.ts';

/** Actions that are levels (held) rather than single presses. */
const HELD = new Set<BindAction>([
  'thrustForward', 'thrustBack', 'thrustLeft', 'thrustRight', 'thrustUp', 'thrustDown',
  'rollLeft', 'rollRight', 'boost', 'brake', 'firePrimary', 'fireSecondary', 'fireTool', 'freeLook',
]);

/** The server accepts at most this much mouse turn per tick and axis, radians. */
const AIM_PER_TICK = 0.5;
const THROTTLE_STEP = 0.1;
/** The subsystem each power key feeds. */
const POWER_KEYS = { powerShields: 'sys', powerEngines: 'eng', powerWeapons: 'wep' } as const;

export class Input {
  /** Called for every single-press action. */
  onAction: (action: BindAction) => void = () => {};
  /** Persistent throttle setpoint: -1..1 in normal flight, 0..1 in cruise. */
  throttle = 0;
  /** Flight assist switched off by the pilot. */
  faOff = false;
  /** Power shared between shields, engines and weapons, packed as in `ShipInput.pips`. */
  pips = DEFAULT_PIPS;
  /** Silent running switched on by the pilot. It ends by itself when the ship docks or is lost. */
  silent = false;
  /** Free-look angles (yaw, pitch) in radians while the free-look key is held. */
  look: [number, number] = [0, 0];

  private readonly held = new Set<BindAction>();
  private readonly codes = new Map<string, BindAction[]>();
  private aimX = 0;
  private aimY = 0;
  private bindingsOf: unknown = null;
  /** Flight mode as of the latest tick or mode change. */
  private mode: FlightMode = FlightMode.Docked;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('mousedown', (e) => this.onButton(e, true));
    window.addEventListener('mouseup', (e) => this.onButton(e, false));
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.canvas) this.addMouse(e.movementX, e.movementY);
    });
    window.addEventListener('wheel', (e) => {
      if (!this.active()) return;
      this.press(e.deltaY < 0 ? 'WheelUp' : 'WheelDown', true);
      this.press(e.deltaY < 0 ? 'WheelUp' : 'WheelDown', false);
    }, { passive: true });
    window.addEventListener('contextmenu', (e) => {
      if (store.phase.value === 'playing' && !isTyping(e.target)) e.preventDefault();
    });
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('pointerlockchange', () => {
      store.pointerLocked.value = document.pointerLockElement === this.canvas;
      if (!store.pointerLocked.value) this.releaseAll();
    });
    // In fullscreen the Keyboard Lock API lets the game receive Ctrl+W instead of closing the tab.
    document.addEventListener('fullscreenchange', () => {
      const kb = (navigator as Navigator & { keyboard?: { lock?: () => Promise<void>; unlock?: () => void } }).keyboard;
      if (document.fullscreenElement) void kb?.lock?.().catch(() => {});
      else kb?.unlock?.();
    });
  }

  /** True while flight controls are live: playing, no panel open, mouse captured, not typing. */
  active(): boolean {
    return (
      store.phase.value === 'playing' && store.panel.value === null &&
      (store.pointerLocked.value || this.testMode) && !isTyping(document.activeElement)
    );
  }

  /** Set by automated tests, where pointer lock is unavailable. */
  testMode = false;

  capture(): void {
    if (document.pointerLockElement !== this.canvas) void Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
  }

  release(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  /** Adds mouse movement in pixels. Public so tests can steer without pointer lock. */
  addMouse(dx: number, dy: number): void {
    const s = store.settings.value;
    const yaw = dx * s.mouseSensitivity;
    const pitch = -dy * s.mouseSensitivity * (s.invertY ? -1 : 1);
    if (this.held.has('freeLook')) {
      this.look[0] = clamp(this.look[0] - yaw, -2.6, 2.6);
      this.look[1] = clamp(this.look[1] + pitch, -1.3, 1.3);
    } else if (this.active()) {
      this.aimX += yaw;
      this.aimY += pitch;
    }
  }

  /** Builds the input for one simulation tick. `dt` is the tick length in seconds. */
  sample(mode: FlightMode, dt: number): Omit<ShipInput, 'seq'> {
    this.mode = mode;
    const live = this.active();
    const h = (a: BindAction): number => (live && this.held.has(a) ? 1 : 0);
    let fwd = h('thrustForward') - h('thrustBack');
    if (mode === FlightMode.Cruise) {
      // In cruise the forward and back keys move the throttle setpoint instead of thrusting.
      this.throttle = clamp(this.throttle + fwd * 0.7 * dt, 0, 1);
      fwd = 0;
    }
    const ax = clamp(this.aimX, -AIM_PER_TICK, AIM_PER_TICK);
    const ay = clamp(this.aimY, -AIM_PER_TICK, AIM_PER_TICK);
    // Whatever exceeds the per-tick cap is carried into the next tick, so fast flicks are not lost.
    this.aimX = live ? this.aimX - ax : 0;
    this.aimY = live ? this.aimY - ay : 0;
    if (!this.held.has('freeLook')) {
      this.look[0] *= Math.exp(-10 * dt);
      this.look[1] *= Math.exp(-10 * dt);
    }
    let buttons = 0;
    if (h('firePrimary')) buttons |= Button.Fire1;
    if (h('fireSecondary')) buttons |= Button.Fire2;
    if (h('fireTool')) buttons |= Button.Fire3;
    if (h('boost')) buttons |= Button.Boost;
    if (h('brake')) buttons |= Button.Brake;
    if (this.faOff) buttons |= Button.FaOff;
    // Like flight assist, these are settings and stay as they are while a panel is open.
    if (this.silent) buttons |= Button.Silent;
    return {
      thrust: [h('thrustRight') - h('thrustLeft'), h('thrustUp') - h('thrustDown'), fwd],
      aim: live ? [ax, ay] : [0, 0],
      roll: h('rollRight') - h('rollLeft'),
      throttle: this.throttle,
      buttons,
      pips: this.pips,
    };
  }

  /**
   * Called on mode changes: clamps the throttle setpoint to what the flight mode allows and ends
   * silent running when the ship docks or is lost.
   */
  setMode(mode: FlightMode): void {
    this.mode = mode;
    if (mode === FlightMode.Docked || mode === FlightMode.Dead) this.silent = false;
    if (mode === FlightMode.Cruise) this.throttle = clamp(this.throttle, 0, 1);
    else if (mode !== FlightMode.Normal) this.throttle = 0;
  }

  /** True while ship systems can be switched: controls live and the ship neither docked nor lost. */
  private inSpace(): boolean {
    return this.active() && this.mode !== FlightMode.Docked && this.mode !== FlightMode.Dead;
  }

  private rebuild(): void {
    const b = store.settings.value.bindings;
    if (b === this.bindingsOf) return;
    this.bindingsOf = b;
    this.codes.clear();
    for (const [action, codes] of Object.entries(b) as [BindAction, string[]][]) {
      for (const code of codes) {
        const list = this.codes.get(code);
        if (list) list.push(action);
        else this.codes.set(code, [action]);
      }
    }
  }

  private press(code: string, down: boolean): boolean {
    this.rebuild();
    const actions = this.codes.get(code);
    if (!actions) return false;
    for (const a of actions) {
      if (HELD.has(a)) {
        if (down) this.held.add(a);
        else this.held.delete(a);
      } else if (down) {
        if (a === 'throttleUp' || a === 'throttleDown') {
          if (this.active()) this.throttle = clamp(this.throttle + (a === 'throttleUp' ? THROTTLE_STEP : -THROTTLE_STEP), -1, 1);
        } else if (a === 'throttleZero') {
          this.throttle = 0;
        } else if (a === 'flightAssist') {
          if (this.active()) this.faOff = !this.faOff;
        } else if (a === 'powerShields' || a === 'powerEngines' || a === 'powerWeapons') {
          if (this.inSpace()) this.pips = addPip(this.pips, POWER_KEYS[a]);
        } else if (a === 'powerReset') {
          if (this.inSpace()) this.pips = DEFAULT_PIPS;
        } else if (a === 'silentRunning') {
          if (this.inSpace()) this.silent = !this.silent;
        } else {
          this.onAction(a);
        }
      }
    }
    return true;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (store.phase.value !== 'playing') return;
    if (isTyping(e.target)) {
      // Escape still leaves a text field, everything else belongs to it.
      if (down && e.code === 'Escape') (e.target as HTMLElement).blur();
      return;
    }
    if (down && e.repeat) {
      if (this.codes.has(e.code)) e.preventDefault();
      return;
    }
    // Keep the browser from scrolling, saving the page or moving focus on bound keys.
    if (this.press(e.code, down)) e.preventDefault();
  }

  private onButton(e: MouseEvent, down: boolean): void {
    if (store.phase.value !== 'playing') return;
    if (!down || this.active()) this.press(`Mouse${e.button}`, down);
  }

  private releaseAll(): void {
    this.held.clear();
    this.aimX = 0;
    this.aimY = 0;
  }
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}
