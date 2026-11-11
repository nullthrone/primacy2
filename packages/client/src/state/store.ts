/**
 * Reactive application state shared by the game core (writer) and the UI (reader).
 * Per-frame values (speeds, positions) are not here: read them from `GameApi.view` whenever the
 * `frame` signal changes.
 */
import { signal } from '@preact/signals';
import type { ChatMessage, EntityInfo, GalaxyView, NoticeLevel, PilotView, StationView, SystemDef } from '@primacy2/shared';
import type { CameraMode, GraphicsSettings } from '../contracts.ts';

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

/** A key binding: `KeyboardEvent.code` values, or `Mouse0`..`Mouse4`, `WheelUp`, `WheelDown`. */
export type Bindings = Record<BindAction, string[]>;

export type BindAction =
  | 'thrustForward' | 'thrustBack' | 'thrustLeft' | 'thrustRight' | 'thrustUp' | 'thrustDown'
  | 'rollLeft' | 'rollRight' | 'boost' | 'brake'
  | 'firePrimary' | 'fireSecondary' | 'fireTool'
  | 'throttleUp' | 'throttleDown' | 'throttleZero'
  | 'flightAssist' | 'cruise' | 'fold' | 'dock'
  | 'targetNext' | 'targetPrev' | 'targetAhead' | 'targetClear'
  | 'camera' | 'galaxyMap' | 'systemMap' | 'contacts' | 'chat' | 'menu' | 'freeLook';

/** Shooter-style defaults: WASD to move, Q/E to roll, Space up, Ctrl down, Shift to boost. */
export const DEFAULT_BINDINGS: Bindings = {
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
  targetNext: ['KeyT'],
  targetPrev: ['KeyG'],
  targetAhead: ['Mouse3', 'KeyY'],
  targetClear: ['KeyU'],
  camera: ['KeyV'],
  galaxyMap: ['KeyM'],
  systemMap: ['KeyN'],
  contacts: ['Tab'],
  chat: ['Enter'],
  menu: ['Escape'],
  freeLook: ['AltLeft'],
};

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
};

export type Store = typeof store;

const SETTINGS_KEY = 'primacy2.settings';

export function loadSettings(): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<Settings>;
    store.settings.value = {
      ...DEFAULT_SETTINGS,
      ...saved,
      graphics: { ...DEFAULT_SETTINGS.graphics, ...(saved.graphics ?? {}) },
      bindings: { ...DEFAULT_BINDINGS, ...(saved.bindings ?? {}) },
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
