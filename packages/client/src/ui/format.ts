/** Unit formatting for the interface. */
import { AU, C } from '@primacy2/shared';
import { fmt, t, type StringKey } from '../i18n/index.ts';
import { store, type BindAction } from '../state/store.ts';

const KEY_GLYPHS: Record<string, string> = { ArrowLeft: '←', ArrowUp: '↑', ArrowRight: '→', ArrowDown: '↓' };
const KEY_NAMES: Record<string, StringKey> = { Mouse0: 'key.mouseLeft', Mouse1: 'key.mouseMiddle', Mouse2: 'key.mouseRight' };

/** A short label for a binding code: `KeyR` is R, `ArrowUp` is ↑, `Mouse1` is the middle mouse button. */
export function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  const named = KEY_NAMES[code];
  return KEY_GLYPHS[code] ?? (named ? t(named) : code);
}

/** The key to name in a hint for an action: its first keyboard binding, or else its first binding. */
export function bindKey(action: BindAction): string {
  const codes = store.settings.value.bindings[action] ?? [];
  const code = codes.find((c) => !/^(Mouse|Wheel)/.test(c)) ?? codes[0];
  return code ? keyName(code) : '–';
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
