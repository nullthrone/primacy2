/**
 * The trade rules as the pilot sees them: what the lots in the hold count as in the current
 * sector, what a jump to another sector does to them, and the words and colours the panels share.
 * The rules themselves are in `@primacy2/shared`; nothing here decides anything.
 */
import {
  lotStatus, type AbsorbLimit, type CargoItem, type GalaxyView, type ImportInfo, type LotStatus, type TrustLevel,
} from '@primacy2/shared';
import { t, type StringKey } from '../i18n/index.ts';

/** What can cut a sale short, as the sell command reports it. */
export type SaleLimit = AbsorbLimit | 'missing';

const TIER_KEY: Record<TrustLevel, StringKey> = {
  union: 'trade.tier.union',
  partner: 'trade.tier.partner',
  visitor: 'trade.tier.visitor',
  blocked: 'trade.tier.blocked',
};

const LOT_KEY: Record<LotStatus, StringKey> = {
  local: 'trade.lot.local',
  free: 'trade.lot.free',
  import: 'trade.lot.import',
  sealed: 'trade.lot.sealed',
};

const LIMIT_KEY: Record<SaleLimit, StringKey> = {
  sealed: 'trade.limit.sealed',
  allowance: 'trade.limit.allowance',
  licence: 'trade.limit.licence',
  missing: 'trade.limit.missing',
};

/**
 * Colour of a relation on the map canvas; the `.chip` classes in ui.css use the same ones.
 * Green passes freely, cyan trades within limits, amber has no value here, red does not enter.
 */
export const TIER_COLOR: Record<TrustLevel, string> = {
  union: '#7dffa8',
  partner: '#7fe9ff',
  visitor: '#ffb347',
  blocked: '#ff4d6d',
};

/** True for a tier this client has words for. Views are checked with it before they are labelled. */
export const isTier = (x: unknown): x is TrustLevel => typeof x === 'string' && Object.hasOwn(TIER_KEY, x);

export const isSaleLimit = (x: unknown): x is SaleLimit => typeof x === 'string' && Object.hasOwn(LIMIT_KEY, x);

export const tierLabel = (tier: TrustLevel): string => t(TIER_KEY[tier]);

export const lotLabel = (status: LotStatus): string => t(LOT_KEY[status]);

/** The sentence for a limit; `name` is the sector whose goods hit it. */
export const limitText = (limit: SaleLimit, name: string): string => t(LIMIT_KEY[limit], { name });

/** Name of a sector by server id, as far as the galaxy view knows it; otherwise the start of the id. */
export function sectorName(galaxy: GalaxyView | null, id: string): string {
  return galaxy?.sectors.find((s) => s.id === id)?.name ?? id.slice(0, 6);
}

/**
 * Tier lookup while docked. The station view lists every origin of foreign cargo in the hold
 * with its tier; an origin it does not list is rated like a visitor, so nothing unknown looks sellable.
 */
export function tiersAtStation(imports: readonly ImportInfo[]): (id: string) => TrustLevel {
  return (id) => imports.find((r) => r.origin === id)?.tier ?? 'visitor';
}

/** Tonnes in the hold that are sealed in this sector, and tonnes that count as imports. */
export interface HoldSummary {
  sealed: number;
  imports: number;
}

/**
 * Sums up the hold in flight, from the seal marks and the tiers in the galaxy view.
 * A lot without a mark from a sector the view does not list is left out: it cannot be judged from here.
 */
export function holdInFlight(cargo: readonly CargoItem[], self: string, galaxy: GalaxyView | null): HoldSummary {
  // Right after a jump the stored galaxy view is still the one of the sector just left.
  const sectors = galaxy && galaxy.self === self ? galaxy.sectors : [];
  const out: HoldSummary = { sealed: 0, imports: 0 };
  for (const lot of cargo) {
    const tier = sectors.find((s) => s.id === lot.origin)?.tier;
    if (!lot.sealed && lot.origin !== self && !isTier(tier)) continue;
    const status = lotStatus(lot, self, () => tier ?? 'visitor');
    if (status === 'sealed') out.sealed += lot.n;
    else if (status === 'import') out.imports += lot.n;
  }
  return out;
}

/** The hold sorted by what a jump to one other sector does to it, in tonnes. */
export interface JumpForecast {
  /** Already sealed: stays sealed wherever it goes. */
  sealed: number;
  /** Labelled with this sector or the destination. */
  direct: number;
  /** Labelled with any third sector. */
  third: number;
}

/**
 * Sorts the hold for a jump from `self` to `dest`. What the destination makes of each group
 * depends on its rating of this sector; see the galaxy map for the wording.
 */
export function jumpForecast(cargo: readonly CargoItem[], self: string, dest: string): JumpForecast {
  const out: JumpForecast = { sealed: 0, direct: 0, third: 0 };
  for (const lot of cargo) {
    if (lot.sealed) out.sealed += lot.n;
    else if (lot.origin === self || lot.origin === dest) out.direct += lot.n;
    else out.third += lot.n;
  }
  return out;
}
