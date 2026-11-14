/**
 * Keyboard, mouse and controller input. Held keys and buttons become the per-tick `ShipInput`;
 * single presses become actions the game handles. Controls follow shooter conventions (see
 * `DEFAULT_BINDINGS`). Controllers come through the Gamepad API, polled once per animation frame
 * (also where no simulation tick runs); `input/gamepad.ts` holds the logic.
 */
import { Button, DEFAULT_PIPS, FlightMode, addPip, type ShipInput } from '@primacy2/shared';
import { store, type BindAction, type PadInfo } from '../state/store.ts';
import {
  DEFAULT_PAD_SETTINGS, devOf, emptyPadState, padName, padStyle, readPads, snapshotPads, type PadAxisAction, type PadSnapshot, type PadState,
} from './gamepad.ts';

/** Actions that are levels (held) rather than single presses. */
const HELD = new Set<BindAction>([
  'thrustForward', 'thrustBack', 'thrustLeft', 'thrustRight', 'thrustUp', 'thrustDown',
  'rollLeft', 'rollRight', 'boost', 'brake', 'firePrimary', 'fireSecondary', 'fireTool', 'freeLook',
]);

/** The server accepts at most this much mouse turn per tick and axis, radians. */
const AIM_PER_TICK = 0.5;
const THROTTLE_STEP = 0.1;
/** Throttle setpoint change per second at full deflection of the keys or the forward axis in cruise. */
const THROTTLE_RATE = 0.7;
/** Used until the game has passed the hull's turn rates, radians per second. */
const FALLBACK_TURN = 0.8;
/** The lever takes over the throttle setpoint when it moves by more than this. */
const LEVER_TAKEOVER = 0.02;
/** While a panel is open a pad press only reaches the game when it toggles a panel. */
const PANEL_ACTIONS = new Set<BindAction>(['menu', 'galaxyMap', 'systemMap', 'contacts', 'chat']);
const ZERO_AXES: Readonly<Record<PadAxisAction, number>> = { yaw: 0, pitch: 0, roll: 0, thrustX: 0, thrustY: 0, thrustZ: 0, throttle: 0 };
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
  /**
   * The hull's turn rates `[yaw, pitch]` in rad/s for the current flight mode, set by the game
   * before each tick. Full stick deflection asks for this much turn per second.
   */
  turnRates: [number, number] = [FALLBACK_TURN, FALLBACK_TURN];

  private readonly held = new Set<BindAction>();
  private readonly codes = new Map<string, BindAction[]>();
  private aimX = 0;
  private aimY = 0;
  private bindingsOf: unknown = null;
  /** Flight mode as of the latest tick or mode change. */
  private mode: FlightMode = FlightMode.Docked;
  private padHeld = new Set<BindAction>();
  /**
   * Actions whose button was down while a menu or panel had the pad. They stay out of `padHeld`
   * until the button is let go: A that pressed "Resume" must not thrust up afterwards.
   */
  private padStale = new Set<BindAction>();
  private padWasBlocked = false;
  private padState: PadState = emptyPadState();
  private padAxes: Readonly<Record<PadAxisAction, number>> = ZERO_AXES;
  private lastLever: number | null = null;
  private padSeq = 0;
  private padListKey = '';
  private padWasActive = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('mousedown', (e) => this.onButton(e, true));
    window.addEventListener('mouseup', (e) => this.onButton(e, false));
    window.addEventListener('mousemove', (e) => {
      if (e.movementX !== 0 || e.movementY !== 0) store.device.value = 'keys';
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
    this.startPadLoop();
  }

  /**
   * True while flight controls are live: playing, no panel open, mouse captured (or a pad was the
   * last device used, which needs no pointer lock), not typing.
   */
  active(): boolean {
    return (
      store.phase.value === 'playing' && store.panel.value === null &&
      (store.pointerLocked.value || this.testMode || store.device.value === 'pad') && !isTyping(document.activeElement)
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
    if (this.isHeld('freeLook')) {
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
    const h = (a: BindAction): number => (live && this.isHeld(a) ? 1 : 0);
    const pa = live ? this.padAxes : ZERO_AXES;
    let fwd = clamp(h('thrustForward') - h('thrustBack') + pa.thrustZ, -1, 1);
    if (mode === FlightMode.Cruise) {
      // In cruise the forward and back keys, and the forward axis, move the throttle setpoint instead of thrusting.
      this.throttle = clamp(this.throttle + fwd * THROTTLE_RATE * dt, 0, 1);
      fwd = 0;
    }
    // A throttle axis that is not a lever moves the setpoint like the forward key, scaled by deflection.
    if (pa.throttle !== 0) {
      this.throttle = clamp(this.throttle + pa.throttle * THROTTLE_RATE * dt, mode === FlightMode.Cruise ? 0 : -1, 1);
    }
    // A stick asks for a turn rate, not an angle: deflection * rate * dt per tick. The simulation
    // works pending aim off at that rate with a lag of about a fourteenth of a second, and when the
    // stick is let go nothing more is added, so the ship stops within its own angular acceleration.
    const k = clamp(store.settings.value.pad?.turnRate ?? 1, 0.1, 1) * dt;
    const px = pa.yaw * this.turnRates[0] * k;
    const py = pa.pitch * this.turnRates[1] * k;
    const ax = clamp(this.aimX, -AIM_PER_TICK, AIM_PER_TICK);
    const ay = clamp(this.aimY, -AIM_PER_TICK, AIM_PER_TICK);
    // Whatever exceeds the per-tick cap is carried into the next tick, so fast flicks are not lost.
    this.aimX = live ? this.aimX - ax : 0;
    this.aimY = live ? this.aimY - ay : 0;
    if (!this.isHeld('freeLook')) {
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
      thrust: [
        clamp(h('thrustRight') - h('thrustLeft') + pa.thrustX, -1, 1),
        clamp(h('thrustUp') - h('thrustDown') + pa.thrustY, -1, 1),
        fwd,
      ],
      aim: live ? [ax + px, ay + py] : [0, 0],
      roll: clamp(h('rollRight') - h('rollLeft') + pa.roll, -1, 1),
      throttle: this.throttle,
      buttons,
      pips: this.pips,
    };
  }

  /**
   * Called on mode changes: clamps the throttle setpoint to what the flight mode allows and ends
   * silent running when the ship docks or is lost. Touching down sets the throttle to zero, so
   * the ship does not leap forward when it lifts off; everything else stays as it is on the
   * ground, where the ship's systems run as in flight.
   */
  setMode(mode: FlightMode): void {
    this.mode = mode;
    if (mode === FlightMode.Docked || mode === FlightMode.Dead) this.silent = false;
    if (mode === FlightMode.Cruise) this.throttle = clamp(this.throttle, 0, 1);
    else if (mode !== FlightMode.Normal) this.throttle = 0;
  }

  /** The raw state of every connected pad, for the binding screen's meters and assignment. */
  snapshot(): PadSnapshot[] {
    return this.readPadSnapshots() ?? [];
  }

  /**
   * Reads the pads once and acts on the result. Runs every animation frame; public so that tests
   * can drive it without waiting for a frame.
   */
  pollPads(): void {
    const pads = this.readPadSnapshots();
    if (!pads) return;
    this.publishPadList(pads);
    const s = store.settings.value;
    const r = readPads(pads, s.bindings, s.pad ?? DEFAULT_PAD_SETTINGS, this.padState);
    this.padState = r.state;
    // While the start screen or a panel has the pad, its buttons press controls there. One that is
    // still down when flight takes over again would fly the ship (A is thrust up, B thrust down),
    // so it waits for its release. The frame after counts too, because the menu loop may close the
    // panel before this loop has seen the button. It hangs on the panel, not on `active()`, so that
    // the press that takes the device over from the mouse works at once; and a fold between two
    // servers is not a menu, so what is held through it stays held.
    const phase = store.phase.value;
    const blocked = store.panel.value !== null || phase === 'menu' || phase === 'connecting' || phase === 'error';
    if (blocked || this.padWasBlocked) {
      this.padStale = new Set(r.held);
    } else {
      for (const a of this.padStale) if (!r.held.has(a)) this.padStale.delete(a);
    }
    this.padWasBlocked = blocked;
    this.padHeld = withoutStale(r.held, this.padStale);
    this.padAxes = r.axes;

    for (const e of r.edges) store.padButton.value = { seq: ++this.padSeq, n: e.button, standard: e.standard };
    // Only a fresh press or a stick that starts to move takes the device over from the mouse.
    if (r.active && (!this.padWasActive || r.edges.length > 0)) {
      store.device.value = 'pad';
      const p = pads.find((x) => x.index === r.activeIndex);
      if (p) store.padStyle.value = padStyle(p.id);
    }
    this.padWasActive = r.active;

    for (const a of r.pressed) {
      // The binding screen is waiting for a button: its presses must not run their actions.
      if (HELD.has(a) || store.phase.value !== 'playing' || store.padCapturing.value) continue;
      if (store.panel.value !== null && !PANEL_ACTIONS.has(a)) continue;
      this.fire(a);
    }
    // The lever takes over the setpoint once it moves; the wheel keeps working in between.
    if (r.lever === null) {
      this.lastLever = null;
    } else if (this.lastLever === null) {
      this.lastLever = r.lever;
    } else if (Math.abs(r.lever - this.lastLever) > LEVER_TAKEOVER) {
      this.lastLever = r.lever;
      if (this.active()) this.throttle = clamp(r.lever, this.mode === FlightMode.Cruise ? 0 : -1, 1);
    }
  }

  private startPadLoop(): void {
    if (typeof requestAnimationFrame !== 'function' || typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    const loop = (): void => {
      this.pollPads();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** Plain snapshots of the connected pads, or null on a page without the Gamepad API. */
  private readPadSnapshots(): PadSnapshot[] | null {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
    try {
      return snapshotPads(navigator.getGamepads());
    } catch {
      // Blocked by a permissions policy or an insecure context: no pads, everything else works.
      return null;
    }
  }

  private publishPadList(pads: PadSnapshot[]): void {
    const key = pads.map((p) => `${p.index}:${p.id}:${p.mapping}:${p.axes.length}:${p.buttons.length}`).join('|');
    if (key === this.padListKey) return;
    this.padListKey = key;
    store.pads.value = pads.map((p): PadInfo => ({
      index: p.index,
      id: p.id,
      name: padName(p.id),
      dev: devOf(p),
      standard: p.mapping === 'standard',
      style: padStyle(p.id),
      axes: p.axes.length,
      buttons: p.buttons.length,
    }));
  }

  private isHeld(a: BindAction): boolean {
    return this.held.has(a) || this.padHeld.has(a);
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
        this.fire(a);
      }
    }
    return true;
  }

  /** A single press, from a key, a mouse button or a pad: one code path for all of them. */
  private fire(a: BindAction): void {
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

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (down) store.device.value = 'keys';
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
    // The side buttons are the browser's back and forward; in the game they choose targets.
    if (e.button >= 3 && !isTyping(e.target)) e.preventDefault();
    if (!down || this.active()) this.press(`Mouse${e.button}`, down);
  }

  private releaseAll(): void {
    this.held.clear();
    this.aimX = 0;
    this.aimY = 0;
  }
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** The held actions that count for flight: all of them, minus those waiting for their release. */
function withoutStale(held: Set<BindAction>, stale: Set<BindAction>): Set<BindAction> {
  if (stale.size === 0) return held;
  const out = new Set<BindAction>();
  for (const a of held) if (!stale.has(a)) out.add(a);
  return out;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}
