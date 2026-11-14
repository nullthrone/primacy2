/**
 * Edits of the controller part of the settings, as pure functions so that the binding screen stays
 * thin and the rules are testable: which codes an assignment replaces, what "clear" records, and
 * what the presets change. Keyboard and mouse codes are never touched here.
 */
import type { BindAction, Bindings, Settings } from '../state/store.ts';
import { addPadDefaults } from '../state/store.ts';
import {
  DEFAULT_PAD_SETTINGS, isPadCode, joystickPreset, type PadAxisAction, type PadAxisBinding, type PadSettings,
} from './gamepad.ts';

export type PadPatch = Pick<Settings, 'bindings' | 'padCleared' | 'pad'>;

const keysOnly = (codes: string[]): string[] => codes.filter((c) => !isPadCode(c));

/** The actions that get a row on the binding screen: the four thrust directions live on the axes. */
export function isRowAction(a: BindAction): boolean {
  return a !== 'thrustForward' && a !== 'thrustBack' && a !== 'thrustLeft' && a !== 'thrustRight';
}

/**
 * Gives an action one controller code. The code is taken away from any other action that had it, so
 * a button never does two things; an action left without a controller code is recorded as cleared.
 */
export function assignPad(s: PadPatch, action: BindAction, code: string): PadPatch {
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

/** Removes the controller codes of an action and remembers that, so the defaults do not return. */
export function clearPad(s: PadPatch, action: BindAction): PadPatch {
  const bindings = { ...s.bindings, [action]: keysOnly(s.bindings[action] ?? []) };
  return { bindings, padCleared: [...new Set([...s.padCleared, action])], pad: s.pad };
}

/** Sets an axis for an action. A binding on the same device is replaced and keeps its shaping. */
export function assignAxis(pad: PadSettings, action: PadAxisAction, dev: string, axis: number): PadSettings {
  const list = pad.axes[action] ?? [];
  const old = list.find((b) => b.dev === dev);
  const next: PadAxisBinding = old
    ? { ...old, axis }
    : { dev, axis, invert: false, deadzone: dev === 'std' ? 0.12 : 0.08, curve: 1.6, ...(action === 'throttle' ? { lever: true } : {}) };
  return { ...pad, axes: { ...pad.axes, [action]: [...list.filter((b) => b.dev !== dev), next] } };
}

export function patchAxis(pad: PadSettings, action: PadAxisAction, i: number, patch: Partial<PadAxisBinding>): PadSettings {
  const list = (pad.axes[action] ?? []).map((b, k) => (k === i ? { ...b, ...patch } : b));
  return { ...pad, axes: { ...pad.axes, [action]: list } };
}

export function removeAxis(pad: PadSettings, action: PadAxisAction, i: number): PadSettings {
  return { ...pad, axes: { ...pad.axes, [action]: (pad.axes[action] ?? []).filter((_, k) => k !== i) } };
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
