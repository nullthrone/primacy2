/**
 * Controller logic with no DOM access, so that it runs in Node under vitest. `Input` polls the
 * Gamepad API, turns each pad into a `PadSnapshot` and hands the lot to `readPads`.
 *
 * Binding codes live in the same per-action lists as keyboard codes:
 *   Pad:<dev>:b<n>        button n
 *   Pad:<dev>:b<m>+b<n>   a chord: button n while button m is held
 *   Pad:<dev>:a<n>+ / -   one half of axis n used as a button
 * `<dev>` is `std` (every device with the standard mapping) or a device key made by `deviceKey`.
 */
import type { BindAction } from '../state/store.ts';

export type PadStyle = 'xbox' | 'playstation' | 'generic';

export type PadAxisAction = 'yaw' | 'pitch' | 'roll' | 'thrustX' | 'thrustY' | 'thrustZ' | 'throttle';

export const PAD_AXIS_ACTIONS: readonly PadAxisAction[] = ['yaw', 'pitch', 'roll', 'thrustX', 'thrustY', 'thrustZ', 'throttle'];

export interface PadAxisBinding {
  /** `std` or a device key. */
  dev: string;
  axis: number;
  invert: boolean;
  /** 0..0.9 */
  deadzone: number;
  /** 1 (linear) .. 3 */
  curve: number;
  /** Throttle only: the full travel of the axis is the setpoint 0..1. */
  lever?: boolean;
}

export interface PadSettings {
  /** Share of the ship's own turn rate at full deflection, 0.2..1. */
  turnRate: number;
  axes: Partial<Record<PadAxisAction, PadAxisBinding[]>>;
}

export interface PadSnapshot {
  id: string;
  index: number;
  mapping: string;
  axes: number[];
  buttons: { pressed: boolean; value: number }[];
}

// ---------------------------------------------------------------------------------------------
// Devices

interface GamepadLike {
  id: string;
  index: number;
  mapping: string;
  connected?: boolean;
  axes: ArrayLike<number>;
  buttons: ArrayLike<{ pressed: boolean; value: number }>;
}

/**
 * Plain snapshots from what `navigator.getGamepads()` returned: null slots and disconnected pads
 * are skipped. It reads fields only, so a test double that is a plain object works as well.
 */
export function snapshotPads(list: ArrayLike<GamepadLike | null> | null | undefined): PadSnapshot[] {
  const out: PadSnapshot[] = [];
  for (const g of Array.from(list ?? [])) {
    if (!g || g.connected === false) continue;
    out.push({
      id: String(g.id), index: g.index, mapping: String(g.mapping ?? ''),
      axes: Array.from(g.axes, (v) => Number(v) || 0),
      buttons: Array.from(g.buttons, (b) => ({ pressed: !!b.pressed, value: Number(b.value) || 0 })),
    });
  }
  return out;
}

/**
 * A short stable key for a device: vendor and product numbers when the id carries them (Chrome
 * writes "Vendor: 044f Product: b10a", Firefox "044f-b10a-Name"), else a slug of the name.
 * Two identical units share a key; that is accepted. The key never contains `:` or `+`.
 */
export function deviceKey(id: string): string {
  const chrome = /vendor:\s*([0-9a-f]{4})\s+product:\s*([0-9a-f]{4})/i.exec(id);
  if (chrome) return `${chrome[1]!.toLowerCase()}-${chrome[2]!.toLowerCase()}`;
  const gecko = /^([0-9a-f]{4})-([0-9a-f]{4})-/i.exec(id);
  if (gecko) return `${gecko[1]!.toLowerCase()}-${gecko[2]!.toLowerCase()}`;
  const slug = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return slug || 'device';
}

export function padStyle(id: string): PadStyle {
  const s = id.toLowerCase();
  if (/xbox|xinput|microsoft|045e/.test(s)) return 'xbox';
  if (/dualshock|dualsense|playstation|sony|054c|wireless controller/.test(s)) return 'playstation';
  return 'generic';
}

/** The device name for display: without the vendor parenthesis or the Firefox number prefix. */
export function padName(id: string): string {
  const name = id.replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  return name || id;
}

/** True when a binding's device part (`std` or a device key) names this pad. */
export function devMatches(dev: string, p: PadSnapshot): boolean {
  return dev === 'std' ? p.mapping === 'standard' : deviceKey(p.id) === dev;
}

/** The `dev` field a new binding for this device gets. */
export function devOf(p: PadSnapshot): string {
  return p.mapping === 'standard' ? 'std' : deviceKey(p.id);
}

// ---------------------------------------------------------------------------------------------
// Binding codes

export type PadCode =
  | { dev: string; kind: 'button'; n: number }
  | { dev: string; kind: 'chord'; m: number; n: number }
  | { dev: string; kind: 'axis'; axis: number; dir: 1 | -1 };

export function parsePadCode(code: string): PadCode | null {
  if (!code.startsWith('Pad:')) return null;
  const parts = code.split(':');
  if (parts.length !== 3 || !parts[1]) return null;
  const dev = parts[1];
  const rest = parts[2]!;
  let m = /^b(\d+)$/.exec(rest);
  if (m) return { dev, kind: 'button', n: Number(m[1]) };
  m = /^b(\d+)\+b(\d+)$/.exec(rest);
  if (m) return { dev, kind: 'chord', m: Number(m[1]), n: Number(m[2]) };
  m = /^a(\d+)([+-])$/.exec(rest);
  if (m) return { dev, kind: 'axis', axis: Number(m[1]), dir: m[2] === '+' ? 1 : -1 };
  return null;
}

export function formatPadCode(c: PadCode): string {
  if (c.kind === 'button') return `Pad:${c.dev}:b${c.n}`;
  if (c.kind === 'chord') return `Pad:${c.dev}:b${c.m}+b${c.n}`;
  return `Pad:${c.dev}:a${c.axis}${c.dir > 0 ? '+' : '-'}`;
}

export const isPadCode = (code: string): boolean => code.startsWith('Pad:');

const XBOX_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'L3', 'R3', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Guide'];
const PS_NAMES = ['Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2', 'Create', 'Options', 'L3', 'R3', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'PS'];

/** The label of a button on the pad's own face: A on an Xbox pad, Cross on a PlayStation pad. */
export function padButtonName(n: number, style: PadStyle): string {
  if (style === 'xbox') return XBOX_NAMES[n] ?? `Button ${n + 1}`;
  if (style === 'playstation') return PS_NAMES[n] ?? `Button ${n + 1}`;
  return `Button ${n + 1}`;
}

export function padAxisName(axis: number, dir?: 1 | -1): string {
  return `Axis ${axis + 1}${dir === undefined ? '' : dir > 0 ? '+' : '−'}`;
}

/** A binding code as text for a hint or the binding screen: "A", "Y + A", "Axis 3+". */
export function padCodeLabel(code: string, style: PadStyle): string {
  const c = parsePadCode(code);
  if (!c) return code;
  if (c.kind === 'button') return padButtonName(c.n, style);
  if (c.kind === 'chord') return `${padButtonName(c.m, style)} + ${padButtonName(c.n, style)}`;
  return padAxisName(c.axis, c.dir);
}

const SHORT_NAMES: Record<string, string> = { 'D-pad up': 'D↑', 'D-pad down': 'D↓', 'D-pad left': 'D←', 'D-pad right': 'D→' };

/**
 * A binding code as a short label for tight places on the HUD: the D-pad is a D with an arrow and a
 * chord has no spaces ("Y+D←" where `padCodeLabel` says "Y + D-pad left").
 */
export function padCodeShort(code: string, style: PadStyle): string {
  const c = parsePadCode(code);
  if (!c) return code;
  const name = (n: number): string => {
    const full = padButtonName(n, style);
    return SHORT_NAMES[full] ?? full;
  };
  if (c.kind === 'button') return name(c.n);
  if (c.kind === 'chord') return `${name(c.m)}+${name(c.n)}`;
  return padAxisName(c.axis, c.dir);
}

// ---------------------------------------------------------------------------------------------
// Defaults

const std = (s: string): string => `Pad:std:${s}`;

/**
 * Standard pad: Y (b3) is the modifier of every chord. The four thrust directions are on the left
 * stick. The D-pad is for targets: left and right step through the places of the system, up takes
 * what lies ahead (and, with nothing new ahead, the next ship), down clears. Stepping through
 * ships with keys of its own (`targetNext`, `targetPrev`) has no button left on a standard pad.
 */
export const DEFAULT_PAD_BINDINGS: Partial<Record<BindAction, string[]>> = {
  firePrimary: [std('b7')],
  fireSecondary: [std('b6')],
  rollRight: [std('b5')],
  rollLeft: [std('b4')],
  thrustUp: [std('b0')],
  thrustDown: [std('b1')],
  fireTool: [std('b2')],
  boost: [std('b10')],
  brake: [std('b11')],
  cruise: [std('b8')],
  menu: [std('b9')],
  targetAhead: [std('b12')],
  navNext: [std('b15')],
  navPrev: [std('b14')],
  targetClear: [std('b13')],
  dock: [std('b3+b0')],
  flightAssist: [std('b3+b1')],
  fold: [std('b3+b2')],
  galaxyMap: [std('b3+b8')],
  systemMap: [std('b3+b9')],
  powerShields: [std('b3+b14')],
  powerEngines: [std('b3+b12')],
  powerWeapons: [std('b3+b15')],
  powerReset: [std('b3+b13')],
  contacts: [std('b3+b4')],
  camera: [std('b3+b5')],
  silentRunning: [std('b3+b10')],
  throttleZero: [std('b3+b11')],
  throttleUp: [std('b3+b7')],
  throttleDown: [std('b3+b6')],
};

/** Actions the analog axes serve, so that they need no button. */
export const AXIS_ONLY_ACTIONS: readonly BindAction[] = ['thrustForward', 'thrustBack', 'thrustLeft', 'thrustRight'];

const stick = (axis: number, invert = false): PadAxisBinding => ({ dev: 'std', axis, invert, deadzone: 0.12, curve: 1.6 });

export const DEFAULT_PAD_SETTINGS: PadSettings = {
  turnRate: 1,
  axes: {
    thrustX: [stick(0)],
    thrustZ: [stick(1, true)],
    yaw: [stick(2)],
    pitch: [stick(3, true)],
  },
};

/** For devices without the standard mapping: sticks and throttles differ, so only the basics are set. */
export function joystickPreset(dev: string): { bindings: Partial<Record<BindAction, string[]>>; pad: PadSettings } {
  const ax = (axis: number, invert = false): PadAxisBinding => ({ dev, axis, invert, deadzone: 0.08, curve: 1.4 });
  return {
    bindings: { firePrimary: [`Pad:${dev}:b0`], fireSecondary: [`Pad:${dev}:b1`] },
    // Pulling the stick back reads positive on axis 1 and is nose up.
    pad: { turnRate: 1, axes: { yaw: [ax(0)], pitch: [ax(1)] } },
  };
}

// ---------------------------------------------------------------------------------------------
// Axis shaping

/** Inside the dead zone 0, outside sign(x) * ((|x| - dz) / (1 - dz)) ^ curve, then inverted. */
export function shapeAxis(value: number, b: Pick<PadAxisBinding, 'invert' | 'deadzone' | 'curve'>): number {
  if (!Number.isFinite(value)) return 0;
  const a = Math.min(1, Math.abs(value));
  const dz = Math.min(0.9, Math.max(0, b.deadzone));
  if (a <= dz) return 0;
  const s = Math.sign(value) * Math.pow((a - dz) / (1 - dz), Math.min(3, Math.max(1, b.curve)));
  return b.invert ? -s : s;
}

/** The throttle lever position 0..1 from the raw axis. */
export function leverValue(raw: number, invert: boolean): number {
  const v = invert ? -raw : raw;
  return Math.min(1, Math.max(0, (v + 1) / 2));
}

// ---------------------------------------------------------------------------------------------
// Reading

const AXIS_ON = 0.5;
const AXIS_OFF = 0.4;
/** The lever counts as moved, for activity, by more than this. */
export const LEVER_MOVE = 0.02;

export interface PadState {
  /** Keys `<pad index>|<code>` of every binding that is on. */
  on: Set<string>;
  held: Set<BindAction>;
  buttons: Map<number, boolean[]>;
  /** Raw value of each lever axis, keyed `<pad index>|<axis>`, to tell a moved lever from a resting one. */
  levers: Map<string, number>;
  active: boolean;
}

export interface PadReading {
  held: Set<BindAction>;
  /** Actions that went on in this reading: once per press. */
  pressed: BindAction[];
  released: BindAction[];
  axes: Record<PadAxisAction, number>;
  /** Absolute throttle lever position 0..1, if a lever is bound and its device is present. */
  lever: number | null;
  /** A button is down, or a bound axis is outside its dead zone, or a bound lever moved. */
  active: boolean;
  /** Index of the first pad that is active in this reading. */
  activeIndex: number | null;
  /** Every button that went down in this reading, bound or not, for menu navigation. */
  edges: { index: number; button: number; standard: boolean }[];
  state: PadState;
}

export const emptyPadState = (): PadState => ({ on: new Set(), held: new Set(), buttons: new Map(), levers: new Map(), active: false });

interface Entry {
  action: BindAction;
  raw: string;
  code: PadCode;
}
interface Compiled {
  entries: Entry[];
  /** Modifier buttons: the first half of every chord. */
  mods: { dev: string; m: number }[];
}

const compiledFor = new WeakMap<object, Compiled>();

function compile(bindings: Record<string, string[]>): Compiled {
  let c = compiledFor.get(bindings);
  if (c) return c;
  c = { entries: [], mods: [] };
  for (const [action, codes] of Object.entries(bindings)) {
    for (const raw of codes) {
      const code = parsePadCode(raw);
      if (!code) continue;
      c.entries.push({ action: action as BindAction, raw, code });
      if (code.kind === 'chord') c.mods.push({ dev: code.dev, m: code.m });
    }
  }
  compiledFor.set(bindings, c);
  return c;
}

const down = (p: PadSnapshot, n: number): boolean => p.buttons[n]?.pressed === true;

export function readPads(
  pads: readonly PadSnapshot[],
  bindings: Record<string, string[]>,
  padSettings: PadSettings,
  prev: PadState | null,
): PadReading {
  const before = prev ?? emptyPadState();
  const c = compile(bindings);
  const on = new Set<string>();
  const held = new Set<BindAction>();
  const buttons = new Map<number, boolean[]>();
  const edges: PadReading['edges'] = [];
  let active = false;
  let activeIndex: number | null = null;
  const markActive = (p: PadSnapshot): void => {
    active = true;
    activeIndex ??= p.index;
  };

  for (const p of pads) {
    const was = before.buttons.get(p.index);
    const now = p.buttons.map((b) => b.pressed);
    buttons.set(p.index, now);
    for (let n = 0; n < now.length; n++) {
      if (!now[n]) continue;
      markActive(p);
      if (!was?.[n]) edges.push({ index: p.index, button: n, standard: p.mapping === 'standard' });
    }
    // While a modifier is held, the plain bindings of this device's other buttons stay silent.
    const mods = new Set<number>();
    for (const x of c.mods) if (devMatches(x.dev, p)) mods.add(x.m);
    let modHeld = false;
    for (const m of mods) if (down(p, m)) modHeld = true;

    for (const e of c.entries) {
      const k = e.code;
      if (!devMatches(k.dev, p)) continue;
      const key = `${p.index}|${e.raw}`;
      let isOn = false;
      if (k.kind === 'button') {
        isOn = down(p, k.n) && !modHeld && !mods.has(k.n);
      } else if (k.kind === 'chord') {
        if (down(p, k.m) && down(p, k.n)) {
          // A chord starts with the second button; holding the target and then the modifier does not count.
          isOn = before.on.has(key) || !was?.[k.n];
        }
      } else {
        const v = (p.axes[k.axis] ?? 0) * k.dir;
        isOn = v > (before.on.has(key) ? AXIS_OFF : AXIS_ON);
        if (isOn) markActive(p);
      }
      if (isOn) {
        on.add(key);
        held.add(e.action);
      }
    }
  }

  const axes: Record<PadAxisAction, number> = { yaw: 0, pitch: 0, roll: 0, thrustX: 0, thrustY: 0, thrustZ: 0, throttle: 0 };
  let lever: number | null = null;
  const levers = new Map<string, number>();
  for (const action of PAD_AXIS_ACTIONS) {
    for (const b of padSettings.axes[action] ?? []) {
      for (const p of pads) {
        if (!devMatches(b.dev, p)) continue;
        const raw = p.axes[b.axis];
        if (raw === undefined) continue;
        if (action === 'throttle' && b.lever) {
          lever = leverValue(raw, b.invert);
          const lk = `${p.index}|${b.axis}`;
          levers.set(lk, raw);
          const was = before.levers.get(lk);
          if (was !== undefined && Math.abs(raw - was) > LEVER_MOVE) markActive(p);
          continue;
        }
        const v = shapeAxis(raw, b);
        if (v !== 0) markActive(p);
        if (Math.abs(v) > Math.abs(axes[action])) axes[action] = v;
      }
    }
  }

  const pressed: BindAction[] = [];
  for (const a of held) if (!before.held.has(a)) pressed.push(a);
  const released: BindAction[] = [];
  for (const a of before.held) if (!held.has(a)) released.push(a);
  return { held, pressed, released, axes, lever, active, activeIndex, edges, state: { on, held, buttons, levers, active } };
}

// ---------------------------------------------------------------------------------------------
// Capture for the binding screen

export type Captured =
  | { kind: 'button'; dev: string; n: number }
  | { kind: 'chord'; dev: string; m: number; n: number }
  | { kind: 'axis'; dev: string; axis: number; dir: 1 | -1 };

const AXIS_CAPTURE = 0.5;

/**
 * The first button newly pressed, or else the axis that moved furthest by more than 0.5 from where
 * it stood in `before`, with its direction. An axis that rests away from the middle (a throttle
 * lever, a trigger at -1) is judged against its resting value, so it is not caught before it moves.
 */
export function captureNext(before: readonly PadSnapshot[], after: readonly PadSnapshot[]): Captured | null {
  for (const p of after) {
    const b = before.find((x) => x.index === p.index);
    for (let n = 0; n < p.buttons.length; n++) {
      if (down(p, n) && !(b && down(b, n))) return { kind: 'button', dev: devOf(p), n };
    }
  }
  let best: Captured | null = null;
  let bestMove = AXIS_CAPTURE;
  for (const p of after) {
    const b = before.find((x) => x.index === p.index);
    if (!b) continue;
    for (let a = 0; a < p.axes.length; a++) {
      const move = (p.axes[a] ?? 0) - (b.axes[a] ?? 0);
      if (Math.abs(move) > bestMove) {
        bestMove = Math.abs(move);
        best = { kind: 'axis', dev: devOf(p), axis: a, dir: move > 0 ? 1 : -1 };
      }
    }
  }
  return best;
}

export interface CaptureProgress {
  /** A button that is held and may turn out to be the modifier of a chord. */
  pending: { dev: string; n: number } | null;
  done: Captured | null;
}

/**
 * One step of an assignment that accepts chords. A button held when the assignment started, or the
 * first one pressed, waits: a second button pressed while it is held makes a chord, and releasing
 * it alone assigns it. An axis moved by itself is taken at once.
 */
export function captureProgress(before: readonly PadSnapshot[], now: readonly PadSnapshot[], pending: CaptureProgress['pending']): CaptureProgress {
  const find = (dev: string): PadSnapshot | undefined => now.find((p) => devOf(p) === dev);
  if (pending) {
    const p = find(pending.dev);
    if (!p || !down(p, pending.n)) return { pending: null, done: { kind: 'button', dev: pending.dev, n: pending.n } };
    for (let n = 0; n < p.buttons.length; n++) {
      if (n === pending.n || !down(p, n)) continue;
      const b = before.find((x) => x.index === p.index);
      // A button that was already down at the start is a second modifier, not the chord's target.
      if (b && down(b, n)) continue;
      return { pending: null, done: { kind: 'chord', dev: pending.dev, m: pending.n, n } };
    }
    return { pending, done: null };
  }
  // A button already held when the assignment began is taken as the modifier.
  for (const b of before) {
    const p = now.find((x) => x.index === b.index);
    if (!p) continue;
    for (let n = 0; n < p.buttons.length; n++) if (down(b, n) && down(p, n)) return { pending: { dev: devOf(p), n }, done: null };
  }
  const first = captureNext(before, now);
  if (first?.kind === 'button') return { pending: { dev: first.dev, n: first.n }, done: null };
  if (first) return { pending: null, done: first };
  return { pending: null, done: null };
}

/** The binding code for a captured button, chord or axis half. */
export function capturedCode(c: Captured): string {
  if (c.kind === 'axis') return formatPadCode({ dev: c.dev, kind: 'axis', axis: c.axis, dir: c.dir });
  if (c.kind === 'chord') return formatPadCode({ dev: c.dev, kind: 'chord', m: c.m, n: c.n });
  return formatPadCode({ dev: c.dev, kind: 'button', n: c.n });
}
