/**
 * Reactive application state shared by the game core (writer) and the UI (reader).
 * Per-frame values (speeds, positions) are not here: read them from `GameApi.view` whenever the
 * `frame` signal changes.
 */
import { signal } from '@preact/signals';
import type { ChatMessage, EntityInfo, GalaxyView, NoticeLevel, PilotView, StationView, SystemDef } from '@primacy2/shared';
import type { CameraMode, GraphicsSettings } from '../contracts.ts';
import {
  DEFAULT_PAD_BINDINGS, DEFAULT_PAD_SETTINGS, PAD_AXIS_ACTIONS, isPadCode, type PadAxisBinding, type PadSettings, type PadStyle,
} from '../input/gamepad.ts';

export type Phase =
  /** Start screen: choose a name and a server. */
  | 'menu'
  | 'connecting'
  | 'playing'
  /** Between servers: the fold tunnel runs while the client connects to the destination. */
  | 'handoff'
  | 'error';

export type Panel = null | 'galaxy' | 'system' | 'station' | 'menu' | 'chat' | 'contacts';

export interface Notice {
  id: number;
  level: NoticeLevel;
  /** Stable code, e.g. `emergency_drop`; the UI may translate it. */
  code: string;
  /** Fallback text in English. */
  text: string;
  /** `performance.now()` when it arrived. */
  at: number;
}

export interface Contact {
  id: number;
  info: EntityInfo;
  /** Metres from the pilot's ship. */
  dist: number;
  hull: number;
  shield: number;
  flags: number;
}

/**
 * A key binding: `KeyboardEvent.code` values, `Mouse0`..`Mouse4`, `WheelUp`, `WheelDown`, and
 * controller codes `Pad:<dev>:...` (see `input/gamepad.ts`).
 */
export type Bindings = Record<BindAction, string[]>;

export type BindAction =
  | 'thrustForward' | 'thrustBack' | 'thrustLeft' | 'thrustRight' | 'thrustUp' | 'thrustDown'
  | 'rollLeft' | 'rollRight' | 'boost' | 'brake'
  | 'firePrimary' | 'fireSecondary' | 'fireTool'
  | 'throttleUp' | 'throttleDown' | 'throttleZero'
  | 'flightAssist' | 'cruise' | 'fold' | 'dock'
  | 'powerShields' | 'powerEngines' | 'powerWeapons' | 'powerReset' | 'silentRunning'
  | 'targetNext' | 'targetPrev' | 'targetAhead' | 'targetClear' | 'navNext' | 'navPrev'
  | 'camera' | 'galaxyMap' | 'systemMap' | 'contacts' | 'chat' | 'menu' | 'freeLook';

/** Shooter-style defaults: WASD to move, Q/E to roll, Space up, Ctrl down, Shift to boost. */
const KEY_BINDINGS: Bindings = {
  thrustForward: ['KeyW'],
  thrustBack: ['KeyS'],
  thrustLeft: ['KeyA'],
  thrustRight: ['KeyD'],
  thrustUp: ['Space'],
  // The browser reserves Ctrl+W (close tab) outside fullscreen, so C is bound as well.
  thrustDown: ['ControlLeft', 'KeyC'],
  rollLeft: ['KeyQ'],
  rollRight: ['KeyE'],
  boost: ['ShiftLeft'],
  brake: ['KeyX'],
  firePrimary: ['Mouse0'],
  fireSecondary: ['Mouse2'],
  fireTool: ['Mouse1', 'KeyR'],
  throttleUp: ['WheelUp'],
  throttleDown: ['WheelDown'],
  throttleZero: ['Backspace'],
  flightAssist: ['KeyZ'],
  cruise: ['KeyJ'],
  fold: ['KeyH'],
  dock: ['KeyF'],
  // Power distribution on the arrow keys: one press moves a pip to that subsystem, down resets.
  powerShields: ['ArrowLeft'],
  powerEngines: ['ArrowUp'],
  powerWeapons: ['ArrowRight'],
  powerReset: ['ArrowDown'],
  silentRunning: ['KeyB'],
  targetNext: ['KeyT'],
  targetPrev: ['KeyG'],
  targetAhead: ['Mouse3', 'KeyY'],
  targetClear: ['KeyU'],
  // Places are stepped through with their own keys, O above L like T above G for ships; the
  // forward side button of the mouse steps on, beside the back button that takes what is ahead.
  navNext: ['KeyO', 'Mouse4'],
  navPrev: ['KeyL'],
  camera: ['KeyV'],
  galaxyMap: ['KeyM'],
  systemMap: ['KeyN'],
  contacts: ['Tab'],
  chat: ['Enter'],
  menu: ['Escape'],
  freeLook: ['AltLeft'],
};

/** The keyboard and mouse defaults with the standard-pad defaults added to each action's list. */
export const DEFAULT_BINDINGS: Bindings = addPadDefaults(KEY_BINDINGS, []);

/**
 * Adds the default pad codes to every action whose list has none, except where the user cleared
 * the pad binding on purpose. Settings saved before controller support gain the pad defaults here.
 * A default whose button the pilot has given to another action is left out: a button never does
 * two things.
 */
export function addPadDefaults(b: Bindings, cleared: readonly BindAction[]): Bindings {
  const out = { ...b };
  const taken = new Set(Object.values(b).flat().filter(isPadCode));
  for (const [action, codes] of Object.entries(DEFAULT_PAD_BINDINGS) as [BindAction, string[]][]) {
    const have = out[action] ?? [];
    if (have.some(isPadCode) || cleared.includes(action)) continue;
    out[action] = [...have, ...codes.filter((c) => !taken.has(c))];
  }
  return out;
}

/**
 * Default pad buttons that went from one action to a newer one: the newer action, the one that
 * had the button before, and the code. D-pad left and right stepped through ships until places
 * got actions of their own.
 */
const MOVED_PAD_DEFAULTS: readonly [BindAction, BindAction, string][] = [
  ['navNext', 'targetNext', 'Pad:std:b15'],
  ['navPrev', 'targetPrev', 'Pad:std:b14'],
];

/**
 * Settings saved before an action existed do not list it. Where the save still gives the older
 * action the button that is now the newer action's default, the older action hands it over, so
 * that an update brings the new layout and no button does two things.
 */
export function handOver(saved: Partial<Bindings>): Partial<Bindings> {
  const out = { ...saved };
  for (const [fresh, old, code] of MOVED_PAD_DEFAULTS) {
    const list = out[old];
    if (saved[fresh] === undefined && list?.includes(code)) out[old] = list.filter((c) => c !== code);
  }
  return out;
}

export interface Settings {
  lang: 'en' | 'de';
  /** Radians of turn per pixel of mouse movement. */
  mouseSensitivity: number;
  invertY: boolean;
  camera: CameraMode;
  /** Vertical field of view in degrees. */
  fov: number;
  graphics: GraphicsSettings;
  /** 0..1 */
  volume: number;
  bindings: Bindings;
  /** Actions whose pad binding the user cleared, so that the defaults are not added back. */
  padCleared: BindAction[];
  /** Analog axes and turn rate for gamepads and joysticks. */
  pad: PadSettings;
  pilotName: string;
  /** Base URL of the server last played on. */
  lastServer: string;
}

export const DEFAULT_SETTINGS: Settings = {
  lang: typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en',
  mouseSensitivity: 0.0022,
  invertY: false,
  camera: 'cockpit',
  fov: 70,
  graphics: { quality: 2, bloom: true, resolution: 1 },
  volume: 0.7,
  bindings: DEFAULT_BINDINGS,
  padCleared: [],
  pad: DEFAULT_PAD_SETTINGS,
  pilotName: '',
  lastServer: '',
};

export const store = {
  phase: signal<Phase>('menu'),
  /** Human-readable reason shown in the `error` phase and on the menu after a failed connection. */
  error: signal<string | null>(null),
  /** Short status line while connecting or handing over. */
  status: signal<string>(''),
  serverId: signal(''),
  serverName: signal(''),
  serverUrl: signal(''),
  pilot: signal<PilotView | null>(null),
  system: signal<SystemDef | null>(null),
  station: signal<StationView | null>(null),
  galaxy: signal<GalaxyView | null>(null),
  /** Newest last; capped at 200. */
  chat: signal<ChatMessage[]>([]),
  /** Newest last; the UI expires them. */
  notices: signal<Notice[]>([]),
  /** Ships and objects in sensor range, nearest first; refreshed a few times per second. */
  contacts: signal<Contact[]>([]),
  targetId: signal<number | null>(null),
  navAnchor: signal<number | null>(null),
  /**
   * The places of the system in the order the pilot steps through them, and when the last step
   * was made (`performance.now()`). The order is taken when the stepping starts and kept while
   * the HUD shows its list, so that the rows do not change places under the pilot's hand.
   */
  navList: signal<{ ids: number[]; at: number } | null>(null),
  /** Selected fold destination (system id). */
  foldTarget: signal<string | null>(null),
  /** Open full-screen panel, if any. While a panel is open, flight input is paused. */
  panel: signal<Panel>(null),
  pointerLocked: signal(false),
  /** Round-trip time in milliseconds. */
  ping: signal(0),
  fps: signal(0),
  /** Increments once per rendered frame. */
  frame: signal(0),
  settings: signal<Settings>(DEFAULT_SETTINGS),
  /** Which kind of device the pilot used last: a pad, or keyboard and mouse. */
  device: signal<'keys' | 'pad'>('keys'),
  /** Button labels for hints: the style of the pad used last. */
  padStyle: signal<PadStyle>('xbox'),
  /** Connected controllers, for the binding screen. `dev` is the device part of binding codes. */
  pads: signal<PadInfo[]>([]),
  /**
   * The latest button that went down on any pad, bound or not (`n` is the button index of the
   * standard mapping on a standard pad). `seq` increases with every press, so equal buttons in a
   * row still change the signal. Menus read this to navigate.
   */
  /** True while the binding screen waits for a button; flight actions from the pad stay silent. */
  padCapturing: signal(false),
  padButton: signal<{ seq: number; n: number; standard: boolean } | null>(null),
};

export interface PadInfo {
  index: number;
  id: string;
  name: string;
  /** Device part of binding codes: `std` for standard-mapping pads, else the device key. */
  dev: string;
  standard: boolean;
  style: PadStyle;
  axes: number;
  buttons: number;
}

export type Store = typeof store;

const SETTINGS_KEY = 'primacy2.settings';

/** One saved axis binding with every field the pad code reads, or null when it names no axis. */
function cleanAxis(saved: unknown): PadAxisBinding | null {
  if (!saved || typeof saved !== 'object') return null;
  const b = saved as Record<string, unknown>;
  if (typeof b.dev !== 'string' || b.dev === '' || typeof b.axis !== 'number' || !Number.isInteger(b.axis) || b.axis < 0) return null;
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const out: PadAxisBinding = { dev: b.dev, axis: b.axis, invert: b.invert === true, deadzone: num(b.deadzone, 0.12), curve: num(b.curve, 1.6) };
  if (typeof b.lever === 'boolean') out.lever = b.lever;
  return out;
}

/**
 * The pad part of saved settings in a shape the pad code can read. That code runs every animation
 * frame and trusts its input: an entry that is no object throws there, a missing dead zone gives
 * NaN, and a turn rate that is no number sends an aim the server drops. Nothing in the game writes
 * such a save, but a hand edit, another build or a later change of the shape can.
 */
function cleanPad(saved: unknown): PadSettings {
  const p = (saved && typeof saved === 'object' ? saved : {}) as { turnRate?: unknown; axes?: unknown };
  const turnRate = typeof p.turnRate === 'number' && Number.isFinite(p.turnRate) ? Math.min(1, Math.max(0.2, p.turnRate)) : DEFAULT_PAD_SETTINGS.turnRate;
  const lists = (p.axes && typeof p.axes === 'object' ? p.axes : {}) as Record<string, unknown>;
  const axes: PadSettings['axes'] = { ...DEFAULT_PAD_SETTINGS.axes };
  for (const action of PAD_AXIS_ACTIONS) {
    const list = lists[action];
    if (!Array.isArray(list)) continue;
    const good = list.map(cleanAxis).filter((b): b is PadAxisBinding => b !== null);
    // A list the pilot emptied stays empty; one with nothing usable in it keeps the default.
    if (good.length > 0 || list.length === 0) axes[action] = good;
  }
  return { turnRate, axes };
}

export function loadSettings(): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<Settings>;
    store.settings.value = {
      ...DEFAULT_SETTINGS,
      ...saved,
      graphics: { ...DEFAULT_SETTINGS.graphics, ...(saved.graphics ?? {}) },
      pad: cleanPad(saved.pad),
      padCleared: saved.padCleared ?? [],
      bindings: addPadDefaults({ ...KEY_BINDINGS, ...handOver(saved.bindings ?? {}) }, saved.padCleared ?? []),
    };
  } catch {
    // Corrupt settings fall back to the defaults.
  }
}

export function updateSettings(patch: Partial<Settings>): void {
  store.settings.value = { ...store.settings.value, ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(store.settings.value));
  } catch {
    // Storage may be unavailable (private mode); settings then last for the session only.
  }
}
