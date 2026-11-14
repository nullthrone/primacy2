/**
 * Edits of the controller part of the settings, as pure functions so that the binding screen stays
 * thin and the rules are testable: which codes an assignment replaces, what "clear" records, and
 * what the presets change. Keyboard and mouse codes are never touched here.
 */
import type { BindAction, Bindings, Settings } from '../state/store.ts';
import { addPadDefaults } from '../state/store.ts';
import {
  DEFAULT_PAD_SETTINGS, captureNext, captureProgress, capturedCode, isPadCode, joystickPreset,
  type CaptureProgress, type PadAxisAction, type PadAxisBinding, type PadSettings, type PadSnapshot,
} from './gamepad.ts';

export type PadPatch = Pick<Settings, 'bindings' | 'padCleared' | 'pad'>;

const keysOnly = (codes: string[]): string[] => codes.filter((c) => !isPadCode(c));

/** The actions that get a row on the binding screen: the four thrust directions live on the axes. */
export function isRowAction(a: BindAction): boolean {
  return a !== 'thrustForward' && a !== 'thrustBack' && a !== 'thrustLeft' && a !== 'thrustRight';
}

/**
 * True when taking `code` away would leave the pause menu without a controller code. The pause
 * menu is the pad's way to the settings and the binding screen, and out of the game; a pilot with
 * nothing but a pad could not open it in flight any more.
 */
function lastMenuCode(s: PadPatch, code: string): boolean {
  const pad = (s.bindings.menu ?? []).filter(isPadCode);
  return pad.length === 1 && pad[0] === code;
}

/**
 * Gives an action one controller code. The code is taken away from any other action that had it, so
 * a button never does two things; an action left without a controller code is recorded as cleared.
 * The one exception is the last controller code of the pause menu: it stays where it is and the
 * settings come back unchanged (the same object). The binding screen uses that as the pad's way to
 * cancel an assignment.
 */
export function assignPad(s: PadPatch, action: BindAction, code: string): PadPatch {
  if (action !== 'menu' && lastMenuCode(s, code)) return s;
  const bindings = { ...s.bindings };
  const cleared = new Set(s.padCleared);
  for (const a of Object.keys(bindings) as BindAction[]) {
    if (a === action || !bindings[a].includes(code)) continue;
    bindings[a] = bindings[a].filter((c) => c !== code);
    if (!bindings[a].some(isPadCode)) cleared.add(a);
  }
  bindings[action] = [...keysOnly(bindings[action] ?? []), code];
  cleared.delete(action);
  return { bindings, padCleared: [...cleared], pad: s.pad };
}

/** Whether the controller codes of an action may be cleared: all but those of the pause menu. */
export function canClearPad(action: BindAction): boolean {
  return action !== 'menu';
}

/**
 * Removes the controller codes of an action and remembers that, so the defaults do not return.
 * The pause menu keeps its code (see `assignPad`); it can be moved to another button instead.
 */
export function clearPad(s: PadPatch, action: BindAction): PadPatch {
  if (!canClearPad(action)) return s;
  const bindings = { ...s.bindings, [action]: keysOnly(s.bindings[action] ?? []) };
  return { bindings, padCleared: [...new Set([...s.padCleared, action])], pad: s.pad };
}

/**
 * Sets an axis for an action. A binding on the same device is replaced and keeps its shaping. The
 * axis is taken away from any other action that had it, as `assignPad` does with a button: one
 * stick axis that both pitches and thrusts is never what the pilot asked for.
 */
export function assignAxis(pad: PadSettings, action: PadAxisAction, dev: string, axis: number): PadSettings {
  const list = pad.axes[action] ?? [];
  const old = list.find((b) => b.dev === dev);
  const next: PadAxisBinding = old
    ? { ...old, axis }
    : { dev, axis, invert: false, deadzone: dev === 'std' ? 0.12 : 0.08, curve: 1.6, ...(action === 'throttle' ? { lever: true } : {}) };
  const axes = { ...pad.axes };
  for (const a of Object.keys(axes) as PadAxisAction[]) {
    const other = axes[a];
    // An action that loses its axis keeps an empty list, so that the default does not come back.
    if (a !== action && other?.some((b) => b.dev === dev && b.axis === axis)) axes[a] = other.filter((b) => !(b.dev === dev && b.axis === axis));
  }
  axes[action] = [...list.filter((b) => b.dev !== dev), next];
  return { ...pad, axes };
}

export function patchAxis(pad: PadSettings, action: PadAxisAction, i: number, patch: Partial<PadAxisBinding>): PadSettings {
  const list = (pad.axes[action] ?? []).map((b, k) => (k === i ? { ...b, ...patch } : b));
  return { ...pad, axes: { ...pad.axes, [action]: list } };
}

export function removeAxis(pad: PadSettings, action: PadAxisAction, i: number): PadSettings {
  return { ...pad, axes: { ...pad.axes, [action]: (pad.axes[action] ?? []).filter((_, k) => k !== i) } };
}

/** What the binding screen is waiting for: a button or chord for an action, or an axis. */
export type ListenTarget = { kind: 'action'; action: BindAction } | { kind: 'axis'; action: PadAxisAction };

export interface ListenStep {
  /** A held button that may turn out to be the modifier of a chord; pass it to the next step. */
  pending: CaptureProgress['pending'];
  /** The settings when the listening is over, or null to go on. The object passed in means: cancelled. */
  done: PadPatch | null;
}

/**
 * One frame of the binding screen while it listens: `before` is what the pads showed when the
 * listening began, `now` what they show. Every way out has to work with nothing but a pad, as
 * Escape is on a keyboard: while an axis is wanted any button cancels, and while a button is wanted
 * the pause-menu button does (its assignment to another action is refused by `assignPad`).
 */
export function listenStep(
  s: PadPatch, target: ListenTarget, before: readonly PadSnapshot[], now: readonly PadSnapshot[], pending: CaptureProgress['pending'],
): ListenStep {
  if (target.kind === 'action') {
    const r = captureProgress(before, now, pending);
    return { pending: r.pending, done: r.done ? assignPad(s, target.action, capturedCode(r.done)) : null };
  }
  const c = captureNext(before, now);
  if (c?.kind === 'axis') return { pending: null, done: { ...s, pad: assignAxis(s.pad, target.action, c.dev, c.axis) } };
  // A button cannot be an analog axis, so it can only mean: not this.
  if (c) return { pending: null, done: s };
  return { pending: null, done: null };
}

/** Back to the defaults of a standard pad, keyboard and mouse as they are. */
export function resetPad(s: PadPatch): PadPatch {
  const kb: Bindings = { ...s.bindings };
  for (const a of Object.keys(kb) as BindAction[]) kb[a] = keysOnly(kb[a]);
  return { bindings: addPadDefaults(kb, []), padCleared: [], pad: DEFAULT_PAD_SETTINGS };
}

/** The Xbox / PlayStation preset is the default table. */
export const presetStandard = resetPad;

/**
 * Adds a device without the standard mapping next to what is there: its fire buttons, and its first
 * two axes as yaw and pitch. Everything else is assigned by the pilot. Untested on hardware.
 */
export function presetJoystick(s: PadPatch, dev: string): PadPatch {
  const j = joystickPreset(dev);
  let out = s;
  for (const [a, codes] of Object.entries(j.bindings) as [BindAction, string[]][]) {
    const have = out.bindings[a].filter((c) => !c.startsWith(`Pad:${dev}:`));
    out = { ...out, bindings: { ...out.bindings, [a]: [...have, ...codes] }, padCleared: out.padCleared.filter((x) => x !== a) };
  }
  let pad = out.pad;
  for (const [a, list] of Object.entries(j.pad.axes) as [PadAxisAction, PadAxisBinding[]][]) {
    pad = { ...pad, axes: { ...pad.axes, [a]: [...(pad.axes[a] ?? []).filter((b) => b.dev !== dev), ...list] } };
  }
  return { ...out, pad };
}
