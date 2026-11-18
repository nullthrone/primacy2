/**
 * Power distribution. The pilot splits reactor output between three subsystems: SYS (shields),
 * ENG (engines) and WEP (weapons). Each holds 0..8 half-pips and the three always sum to 12.
 *
 * The setting travels packed in `ShipInput.pips`, so the client's prediction replays it, and
 * `stepShip` copies the applied value into `ShipState.pips` for everything else to read.
 * Every effect is a multiplier that is exactly 1 at the default 4/4/4.
 */

/** Half-pips one subsystem can hold. */
export const PIP_MAX = 8;
/** Half-pips shared between the three subsystems. */
export const PIP_TOTAL = 12;

/** Share of each subsystem in half-pips. */
export interface Pips {
  sys: number;
  eng: number;
  wep: number;
}

export type PipSystem = keyof Pips;

/** Packs three half-pip counts as `sys | eng << 4 | wep << 8`. Does not check them; see `normalizePips`. */
export function packPips(sys: number, eng: number, wep: number): number {
  return (sys & 15) | ((eng & 15) << 4) | ((wep & 15) << 8);
}

/** The balanced setting, 4/4/4. */
export const DEFAULT_PIPS = packPips(4, 4, 4);

export function unpackPips(n: number): Pips {
  return { sys: n & 15, eng: (n >> 4) & 15, wep: (n >> 8) & 15 };
}

/**
 * Returns `x` when it is a valid packed setting (each share 0..8, sum 12) and the default
 * otherwise, including for a missing value. Use it on anything that comes from outside.
 */
export function normalizePips(x: unknown): number {
  if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x > 0xfff) return DEFAULT_PIPS;
  const sys = x & 15;
  const eng = (x >> 4) & 15;
  const wep = (x >> 8) & 15;
  return sys <= PIP_MAX && eng <= PIP_MAX && wep <= PIP_MAX && sys + eng + wep === PIP_TOTAL ? x : DEFAULT_PIPS;
}

/**
 * Moves up to one full pip (two halves) to a subsystem, taking each half from whichever of the
 * other two currently holds more. The result is always a valid setting; a full subsystem is
 * left as it is.
 */
export function addPip(pips: number, to: PipSystem): number {
  const p = unpackPips(normalizePips(pips));
  const others = (['sys', 'eng', 'wep'] as const).filter((k) => k !== to);
  for (let i = 0; i < 2 && p[to] < PIP_MAX; i++) {
    const from = p[others[0]!] >= p[others[1]!] ? others[0]! : others[1]!;
    if (p[from] === 0) break;
    p[from]--;
    p[to]++;
  }
  return packPips(p.sys, p.eng, p.wep);
}

// Each multiplier is written as 1 + (share - 4) * step, which is exactly 1 at the default share.

/** ENG: flight-assist speed limit, boost speed and linear acceleration. 0.8 at no pips, 1.2 at full. */
export function engineMul(pips: number): number {
  return 1 + (((pips >> 4) & 15) - 4) * 0.05;
}

/** SYS: shield regeneration rate. 0.5 at no pips, 1.5 at full. */
export function shieldRegenMul(pips: number): number {
  return 1 + ((pips & 15) - 4) * 0.125;
}

/** SYS: damage the shields take from a hit. 1.15 at no pips, 0.85 at full. */
export function shieldDamageMul(pips: number): number {
  return 1 - ((pips & 15) - 4) * 0.0375;
}

/** WEP: energy a weapon draws per shot (or per second for beams). 1.3 at no pips, 0.7 at full. */
export function weaponEnergyMul(pips: number): number {
  return 1 - (((pips >> 8) & 15) - 4) * 0.075;
}
