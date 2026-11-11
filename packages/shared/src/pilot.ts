/**
 * What a pilot owns.
 *
 * `Passport` is the portable part: it travels between servers inside a signed transfer ticket.
 * Everything else (credits, reputation, missions) is local to one server.
 */
import { COMMODITIES, computeShipStats, normalizeLoadout, starterLoadout, type Loadout } from './catalog.ts';
import { MAX_NAME_LENGTH } from './constants.ts';

export interface CargoItem {
  /** Commodity id. */
  c: string;
  /** Whole tonnes. */
  n: number;
  /** Server id where the cargo was acquired. Decides tariffs when it is sold elsewhere. */
  origin: string;
}

export interface PilotStats {
  kills: number;
  deaths: number;
  jumps: number;
  /** Light years travelled by fold jumps. */
  distance: number;
  /** Tonnes mined. */
  mined: number;
  tradeProfit: number;
  /** Bodies scanned first. */
  discoveries: number;
  /** Servers visited (count of distinct sectors). */
  sectors: number;
}

export interface ShipRecord {
  loadout: Loadout;
  /** Hull points remaining. */
  hull: number;
  /** Tonnes of fuel. */
  fuel: number;
  cargo: CargoItem[];
}

export interface Passport {
  playerId: string;
  name: string;
  ship: ShipRecord;
  stats: PilotStats;
  /** Server id where the pilot was first created. */
  home: string;
  /** Monotonic counter, incremented on every handoff. */
  seq: number;
}

export const emptyStats = (): PilotStats => ({
  kills: 0, deaths: 0, jumps: 0, distance: 0, mined: 0, tradeProfit: 0, discoveries: 0, sectors: 1,
});

export function newPassport(playerId: string, name: string, home: string): Passport {
  const loadout = starterLoadout();
  const stats = computeShipStats(loadout);
  return {
    playerId,
    name: sanitizeName(name),
    ship: { loadout, hull: stats.hullMax, fuel: stats.fuelCap, cargo: [] },
    stats: emptyStats(),
    home,
    seq: 0,
  };
}

/** Printable, trimmed, length-limited pilot name. Falls back to `Pilot`. */
export function sanitizeName(name: unknown): string {
  if (typeof name !== 'string') return 'Pilot';
  const cleaned = name
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _\-.']/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned.length >= 2 ? cleaned : 'Pilot';
}

export const cargoTonnes = (cargo: readonly CargoItem[]): number => cargo.reduce((sum, it) => sum + it.n, 0);

const finiteOr = (x: unknown, fallback: number): number =>
  typeof x === 'number' && Number.isFinite(x) ? x : fallback;
const nonNegInt = (x: unknown, max: number): number =>
  Math.min(max, Math.max(0, Math.floor(finiteOr(x, 0))));

export interface SanitizeOptions {
  /** Drop all cargo (trust level `restricted`). */
  impoundCargo?: boolean;
  /** Server id to record as cargo origin when the incoming value is not a valid id. */
  issuer: string;
}

/**
 * Rebuilds a passport received from another server so that nothing in it can exceed what this
 * server's own rules allow. The input is treated as hostile: every field is re-derived or clamped,
 * unknown ids are dropped, and no object from the input is reused.
 */
export function sanitizePassport(input: unknown, playerId: string, opts: SanitizeOptions): Passport {
  const p = (input && typeof input === 'object' ? input : {}) as Partial<Passport>;
  const shipIn = (p.ship && typeof p.ship === 'object' ? p.ship : {}) as Partial<ShipRecord>;
  const loadout = normalizeLoadout(shipIn.loadout as Loadout | undefined);
  const stats = computeShipStats(loadout);

  const cargo: CargoItem[] = [];
  if (!opts.impoundCargo && Array.isArray(shipIn.cargo)) {
    let room = Math.floor(stats.cargoCap);
    const merged = new Map<string, CargoItem>();
    for (const raw of shipIn.cargo.slice(0, 256)) {
      if (!raw || typeof raw !== 'object' || room <= 0) continue;
      const item = raw as Partial<CargoItem>;
      if (typeof item.c !== 'string' || !Object.hasOwn(COMMODITIES, item.c)) continue;
      const n = Math.min(room, nonNegInt(item.n, 1_000_000));
      if (n <= 0) continue;
      const origin = typeof item.origin === 'string' && /^[a-z2-7]{16}$/.test(item.origin) ? item.origin : opts.issuer;
      const key = item.c + '|' + origin;
      const have = merged.get(key);
      if (have) have.n += n;
      else merged.set(key, { c: item.c, n, origin });
      room -= n;
    }
    cargo.push(...merged.values());
  }

  const s = (p.stats && typeof p.stats === 'object' ? p.stats : {}) as Partial<PilotStats>;
  const big = 1e12;
  return {
    playerId,
    name: sanitizeName(p.name),
    ship: {
      loadout,
      // A ship always arrives flyable: at least 10 % hull, never more than the hull allows.
      hull: Math.min(stats.hullMax, Math.max(stats.hullMax * 0.1, finiteOr(shipIn.hull, stats.hullMax))),
      fuel: Math.min(stats.fuelCap, Math.max(0, finiteOr(shipIn.fuel, 0))),
      cargo,
    },
    stats: {
      kills: nonNegInt(s.kills, big),
      deaths: nonNegInt(s.deaths, big),
      jumps: nonNegInt(s.jumps, big),
      distance: Math.min(big, Math.max(0, finiteOr(s.distance, 0))),
      mined: nonNegInt(s.mined, big),
      tradeProfit: Math.min(big, Math.max(-big, Math.floor(finiteOr(s.tradeProfit, 0)))),
      discoveries: nonNegInt(s.discoveries, big),
      sectors: Math.max(1, nonNegInt(s.sectors, 1e6)),
    },
    home: typeof p.home === 'string' && /^[a-z2-7]{16}$/.test(p.home) ? p.home : opts.issuer,
    seq: nonNegInt(p.seq, Number.MAX_SAFE_INTEGER),
  };
}
