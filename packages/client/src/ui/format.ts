/** Unit formatting for the interface. */
import { AU, C } from '@primacy2/shared';
import { fmt, t, type StringKey } from '../i18n/index.ts';
import { isPadCode, padButtonName, padCodeLabel, padCodeShort, type PadStyle, type PadWords } from '../input/gamepad.ts';
import { store, type BindAction } from '../state/store.ts';

const KEY_GLYPHS: Record<string, string> = { ArrowLeft: '←', ArrowUp: '↑', ArrowRight: '→', ArrowDown: '↓' };
const KEY_NAMES: Record<string, StringKey> = {
  Mouse0: 'key.mouseLeft', Mouse1: 'key.mouseMiddle', Mouse2: 'key.mouseRight', Mouse3: 'key.mouseBack', Mouse4: 'key.mouseForward', Space: 'key.space',
  ControlLeft: 'key.ctrl', ControlRight: 'key.ctrl', ShiftLeft: 'key.shift', ShiftRight: 'key.shift',
  AltLeft: 'key.alt', AltRight: 'key.alt', Escape: 'key.esc',
};

/** A short label for a binding code: `KeyR` is R, `ArrowUp` is ↑, `Mouse1` is the middle mouse button. */
export function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  const named = KEY_NAMES[code];
  return KEY_GLYPHS[code] ?? (named ? t(named) : code);
}

/**
 * The words pad labels are made of ("D-pad left", "Button 14", "Axis 3"), in the language of the
 * interface. `input/gamepad.ts` knows no languages, so every place that shows a label passes these.
 */
export function padWords(): PadWords {
  return {
    dpad: t('pad.word.dpad'), up: t('pad.word.up'), down: t('pad.word.down'), left: t('pad.word.left'), right: t('pad.word.right'),
    button: t('pad.word.button'), axis: t('pad.word.axis'),
  };
}

/** The control to name for an action, with `padLabel` making the text for a pad code. */
function bindLabel(action: BindAction, padLabel: (code: string, style: PadStyle, words: PadWords) => string): string {
  const codes = store.settings.value.bindings[action] ?? [];
  const pad = codes.find(isPadCode);
  if (store.device.value === 'pad' && pad) return padLabel(pad, store.padStyle.value, padWords());
  const keys = codes.filter((c) => !isPadCode(c));
  const code = keys.find((c) => !/^(Mouse|Wheel)/.test(c)) ?? keys[0];
  if (code) return keyName(code);
  return pad ? padLabel(pad, store.padStyle.value, padWords()) : '–';
}

/**
 * What the binding screen says while it waits. It names the way out that works with nothing but a
 * pad: any button while an axis is wanted, and the button of the pause menu while a button is
 * wanted (its current one, read from the bindings; see `assignPad` for why it cancels).
 */
export function listenHint(kind: 'action' | 'axis'): string {
  if (kind === 'axis') return t('pad.listenAxis');
  const menu = (store.settings.value.bindings.menu ?? []).find(isPadCode);
  // A save from before the pause menu kept its code may have none: then only Escape cancels.
  if (!menu) return t('pad.listenButtonKeys');
  return t('pad.listenButton', { MENU: padCodeLabel(menu, store.padStyle.value, padWords()) });
}

/**
 * The control to name in a hint for an action. With a pad as the device last used it is the pad's
 * label (A on an Xbox pad, Cross on a PlayStation pad, "Y + A" for a chord); otherwise the first
 * keyboard binding, or else the first binding.
 */
export function bindKey(action: BindAction): string {
  return bindLabel(action, padCodeLabel);
}

/** As `bindKey`, for a key cap on the HUD, where room is tight: a pad's label in its short form ("Y+D←"). */
export function bindKeyShort(action: BindAction): string {
  return bindLabel(action, padCodeShort);
}

/** Whether an action has a control on the device in use: a pad code for a pad, anything else otherwise. */
export function hasBinding(action: BindAction): boolean {
  const codes = store.settings.value.bindings[action] ?? [];
  const pad = store.device.value === 'pad';
  return codes.some((c) => isPadCode(c) === pad);
}

/** Button names for the pad help lines, by the style of the pad in use. */
export function padHelpParams(): Record<string, string> {
  const s = store.padStyle.value;
  const n = (i: number): string => padButtonName(i, s);
  return { A: n(0), B: n(1), X: n(2), Y: n(3), LB: n(4), RB: n(5), LT: n(6), RT: n(7), VIEW: n(8), MENU: n(9), L3: n(10), R3: n(11), key: n(0) };
}

/** Metres as m, km, Mm, light seconds or AU, whichever reads best. */
export function fmtDistance(m: number): string {
  const a = Math.abs(m);
  if (a < 1_000) return `${fmt(m)} m`;
  if (a < 1_000_000) return `${fmt(m / 1_000, 1)} km`;
  if (a < C) return `${fmt(m / 1_000_000, a < 1e8 ? 1 : 0)} Mm`;
  if (a < AU * 0.5) return `${fmt(m / C, 1)} ls`;
  return `${fmt(m / AU, 2)} AU`;
}

/** Metres per second as m/s, km/s or multiples of light speed. */
export function fmtSpeed(v: number): string {
  const a = Math.abs(v);
  if (a < 1_000) return `${fmt(v)} m/s`;
  if (a < C * 0.1) return `${fmt(v / 1_000, a < 100_000 ? 1 : 0)} km/s`;
  return `${fmt(v / C, a < C * 10 ? 2 : 0)} c`;
}

/**
 * Height above the ground. Metres below one kilometre, with tenths below 20 m where a touchdown
 * is judged; kilometres above, to ten metres up to 100 km. The steps are set where the rounded
 * number changes its form, so the readout never shows "1,000 m".
 */
export function fmtHeight(m: number): string {
  const a = Math.abs(m);
  if (a < 19.95) return `${fmt(m, 1)} m`;
  if (a < 999.5) return `${fmt(m)} m`;
  if (a < 99_995) return `${fmt(m / 1_000, 2)} km`;
  if (a < 999_950) return `${fmt(m / 1_000, 1)} km`;
  return `${fmt(m / 1_000)} km`;
}

/** A rate of climb or sink, or a speed near a landing limit: tenths of a metre per second below 100 m/s. */
export function fmtRate(v: number): string {
  return Math.abs(v) < 99.95 ? `${fmt(v, 1)} m/s` : fmtSpeed(v);
}

/** Seconds as 12 s, 3:05 or 1:02:03. */
export function fmtDuration(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '--';
  if (s < 60) return `${Math.round(s)} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export const STAR_COLORS: Record<string, string> = {
  O: '#9bb0ff', B: '#aabfff', A: '#cad7ff', F: '#f8f7ff', G: '#fff4ea', K: '#ffd2a1', M: '#ffb56c',
  WD: '#e8f0ff', NS: '#b8e0ff', BH: '#c080ff',
};
