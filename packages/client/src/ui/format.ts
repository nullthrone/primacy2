/** Unit formatting for the interface. */
import { AU, C } from '@primacy2/shared';
import { fmt } from '../i18n/index.ts';

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
