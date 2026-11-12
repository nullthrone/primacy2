/**
 * The trade model between servers, as pure functions.
 *
 * No server can check how goods on another server came to be, so every server trusts only its
 * own books. It rates every other server (`TrustLevel`), decides on arrival what each lot of
 * cargo counts as, and limits how much foreign cargo can be turned into value locally.
 * The books themselves (ledger, licences) live in the server; the rules live here.
 */
import { COMMODITIES, ECONOMIES, GATE_COST, HULLS, MODULES, type Loadout } from './catalog.ts';
import * as constants from './constants.ts';
import { canonicalJson, sha256Hex } from './crypto.ts';
import type { ServerDescriptor, TrustLevel } from './federation.ts';
import { addLot, type CargoItem } from './pilot.ts';

// ---------------------------------------------------------------------------------------------
// Value
// ---------------------------------------------------------------------------------------------

/** Trade units of `n` tonnes of a commodity: tonnes times its catalog price. Unknown goods are worth nothing. */
export function tradeUnits(c: string, n: number): number {
  if (typeof c !== 'string' || !Object.hasOwn(COMMODITIES, c) || !(n > 0)) return 0;
  return n * COMMODITIES[c]!.price;
}

/** Trade units of a whole list of lots. */
export const cargoTradeUnits = (lots: readonly Pick<CargoItem, 'c' | 'n'>[]): number =>
  lots.reduce((sum, it) => sum + tradeUnits(it.c, it.n), 0);

// ---------------------------------------------------------------------------------------------
// Rules fingerprint
// ---------------------------------------------------------------------------------------------

/**
 * A hash over the catalog tables and every rule constant. Two servers with the same fingerprint
 * run the same goods, ships and physics. `extra` lets a server add rule values of its own modules.
 */
export function rulesFingerprint(extra: Record<string, unknown> = {}): string {
  const rules: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(constants)) {
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) rules[k] = v;
  }
  return sha256Hex(
    canonicalJson({ hulls: HULLS, modules: MODULES, commodities: COMMODITIES, economies: ECONOMIES, gateCost: GATE_COST, rules, extra }),
  );
}

// ---------------------------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------------------------

/**
 * The tier a server actually applies to another one. A customs union only exists when both
 * sides rate each other `union` and publish the same rules fingerprint; otherwise the relation
 * is treated as `partner`. `theirs` is the other side's rating of this server, null when unknown.
 */
export function effectiveTier(mine: TrustLevel, theirs: TrustLevel | null, rulesMatch: boolean): TrustLevel {
  if (mine === 'union' && !(theirs === 'union' && rulesMatch)) return 'partner';
  return mine;
}

/**
 * The rating a descriptor publishes for server `id`, or null when the descriptor says nothing
 * about trade (one stored by an older version). `union` counts only when the id is listed:
 * a default never makes a customs union.
 */
export function publishedRating(desc: Pick<ServerDescriptor, 'rules' | 'trade'>, id: string): TrustLevel | null {
  const t = desc.trade;
  if (!t || !Array.isArray(t.union) || !Array.isArray(t.partner)) return null;
  if (t.union.includes(id)) return 'union';
  if (t.partner.includes(id)) return 'partner';
  const d = desc.rules?.defaultTrust;
  return d === 'union' ? 'partner' : (d ?? null);
}

// ---------------------------------------------------------------------------------------------
// Cargo: attribution on arrival and status in the hold
// ---------------------------------------------------------------------------------------------

/**
 * What a lot in a hold counts as on this server:
 * `local` was made here, `free` comes from a customs union member, `import` comes from a partner
 * and is limited by the trade balance and the pilot's licence, `sealed` cannot become value here.
 */
export type LotStatus = 'local' | 'free' | 'import' | 'sealed';

/**
 * Status of a lot held on server `self`. `tierOf` gives the effective tier of a server id.
 * A lot without the sealed flag whose origin is (or has become) a visitor or blocked server
 * counts as sealed too, so a rating that is lowered later takes effect on goods already here.
 */
export function lotStatus(lot: Pick<CargoItem, 'origin' | 'sealed'>, self: string, tierOf: (id: string) => TrustLevel): LotStatus {
  if (lot.sealed) return 'sealed';
  if (lot.origin === self) return 'local';
  const tier = tierOf(lot.origin);
  return tier === 'union' ? 'free' : tier === 'partner' ? 'import' : 'sealed';
}

export interface ArrivalRules {
  /** This server's id. */
  self: string;
  /** The server that issued the transfer ticket. */
  issuer: string;
  /** Effective tier of the issuer. */
  issuerTier: TrustLevel;
  /** Effective tier of any other server id, by this server's own rating. */
  tierOf(id: string): TrustLevel;
}

/**
 * Decides what one lot on an arriving ship counts as. Returns a new lot; the label is only ever
 * rewritten to the issuer's id, and only for a partner's own goods and this server's goods coming back.
 *
 * - A lot the issuer already marked sealed stays sealed, whoever the issuer is. Without this a
 *   cheat could label minted goods with this server's id and pass them through an honest server.
 * - From a visitor (or anything lower): every lot is sealed.
 * - From a partner: the issuer's own label and this server's label become an import attributed
 *   to the issuer; any other label is sealed.
 * - From a customs union member: the label is believed and rated by this server's own tier for it:
 *   own id is local, a union member is free, a partner is an import against that partner, the rest is sealed.
 */
export function attributeLot(lot: CargoItem, r: ArrivalRules): CargoItem {
  const out = (origin: string, sealed: boolean): CargoItem =>
    sealed ? { c: lot.c, n: lot.n, origin, sealed: true } : { c: lot.c, n: lot.n, origin };
  if (lot.sealed) return out(lot.origin, true);
  if (r.issuerTier === 'union') {
    if (lot.origin === r.self || lot.origin === r.issuer) return out(lot.origin, false);
    const tier = r.tierOf(lot.origin);
    return out(lot.origin, tier !== 'union' && tier !== 'partner');
  }
  if (r.issuerTier === 'partner') {
    if (lot.origin === r.issuer || lot.origin === r.self) return out(r.issuer, false);
    return out(lot.origin, true);
  }
  return out(lot.origin, true);
}

/**
 * Splits an arriving hold into the goods the pilot is taking back home and the rest. `left` is the
 * trade value of local, unsealed cargo this pilot carried out (see `DepartedShip.cargo`). Lots that
 * claim this server's label, are not sealed, and fit under that value, whole tonnes at a time, come
 * back as local goods; everything else (other labels, sealed lots, more than was carried out, other
 * goods worth more) goes on to `attributeCargo` as usual. A server that returns different goods
 * under this server's label gains nothing: the value that left is the most that can return.
 */
export function recogniseReturning(
  cargo: readonly CargoItem[], self: string, left: number,
): { back: CargoItem[]; rest: CargoItem[]; value: number } {
  const back: CargoItem[] = [];
  const rest: CargoItem[] = [];
  let value = 0;
  let room = Number.isFinite(left) && left > 0 ? left : 0;
  for (const lot of cargo) {
    const price = tradeUnits(lot.c, 1);
    if (lot.sealed || lot.origin !== self || !(price > 0) || room < price) {
      rest.push(lot);
      continue;
    }
    const n = Math.min(lot.n, Math.floor(room / price));
    back.push({ c: lot.c, n, origin: self });
    room -= n * price;
    value += n * price;
    if (n < lot.n) rest.push({ c: lot.c, n: lot.n - n, origin: lot.origin });
  }
  return { back, rest, value };
}

/** Attributes every lot of an arriving hold and merges lots that end up alike. */
export function attributeCargo(cargo: readonly CargoItem[], r: ArrivalRules): CargoItem[] {
  const out: CargoItem[] = [];
  for (const lot of cargo) {
    const a = attributeLot(lot, r);
    addLot(out, a.c, a.n, a.origin, a.sealed === true);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Trade balance and import licence
// ---------------------------------------------------------------------------------------------

/** One peer's row in a server's books, in trade units. */
export interface TradeLedger {
  /** Local goods that left for the peer on tickets the peer redeemed. */
  exports: number;
  /** Goods attributed to the peer that were turned into value here. */
  imports: number;
}

/** Trade units of imports a partner may still have absorbed: exports + credit line - imports, never negative. */
export function remainingAllowance(ledger: TradeLedger, creditLine: number): number {
  return Math.max(0, ledger.exports + creditLine - ledger.imports);
}

/** A pilot's import licence in a server's books, in trade units. */
export interface LicenceAccount {
  /** Non-trade income earned on this server: missions, bounties, survey data, ore mined here. */
  income: number;
  /** Imports absorbed for this pilot so far. */
  used: number;
}

/** Trade units of imports a pilot may still have absorbed: rate times non-trade income, less what was used. */
export function remainingLicence(licence: LicenceAccount, rate: number): number {
  return Math.max(0, licence.income * rate - licence.used);
}

/** Why a lot could not be absorbed in full. */
export type AbsorbLimit = 'sealed' | 'allowance' | 'licence';

/**
 * How many whole tonnes of a lot may be turned into value, given its status and what is left of
 * the partner's allowance and the pilot's licence (both in trade units). Local and union goods
 * pass untouched; sealed goods never pass.
 */
export function absorbable(
  c: string, n: number, status: LotStatus, allowanceLeft: number, licenceLeft: number,
): { n: number; limit: AbsorbLimit | null } {
  const want = Math.max(0, Math.floor(n));
  if (status === 'sealed') return { n: 0, limit: want > 0 ? 'sealed' : null };
  if (status !== 'import') return { n: want, limit: null };
  const price = tradeUnits(c, 1);
  if (price <= 0) return { n: want, limit: null };
  const byAllowance = Math.floor(Math.max(0, allowanceLeft) / price);
  const byLicence = Math.floor(Math.max(0, licenceLeft) / price);
  const take = Math.min(want, byAllowance, byLicence);
  if (take >= want) return { n: want, limit: null };
  return { n: take, limit: byAllowance <= byLicence ? 'allowance' : 'licence' };
}

// ---------------------------------------------------------------------------------------------
// Ships: binding and class limits
// ---------------------------------------------------------------------------------------------

/**
 * Which parts of a ship are bound on a server: a bound hull or module was not paid for there,
 * refunds nothing when sold or swapped, and yields no scrap or parts as a wreck.
 * `slots` is index-aligned with the hull's slots.
 */
export interface ShipBinding {
  hull: boolean;
  slots: boolean[];
}

/** What a server remembers of a ship that left it, to recognise it when it comes back. */
export interface DepartedShip {
  hull: string;
  modules: (string | null)[];
  /** The binding the ship had when it left. */
  bound: ShipBinding;
  /** Trade units of local, unsealed cargo the ship carried out; it may come back as local goods, up to this value. */
  cargo?: number;
}

/**
 * Binding of an arriving ship. From a customs union member nothing is bound except what that
 * member says is (`claimed`); from everyone else the whole ship is bound. Whatever matches the
 * ship this pilot left with, and was not bound then, is local again.
 */
export function bindArrivingShip(
  loadout: Loadout, issuerTier: TrustLevel, claimed: ShipBinding | null | undefined, departed: DepartedShip | null | undefined,
): ShipBinding {
  const union = issuerTier === 'union';
  const bound: ShipBinding = {
    hull: union ? claimed?.hull === true : true,
    slots: loadout.modules.map((_, i) => (union ? claimed?.slots?.[i] === true : true)),
  };
  if (departed && departed.hull === loadout.hull) {
    if (departed.bound.hull === false) bound.hull = false;
    for (let i = 0; i < bound.slots.length; i++) {
      if (departed.modules[i] === loadout.modules[i] && departed.bound.slots[i] === false) bound.slots[i] = false;
    }
  }
  return bound;
}

/** Largest hull price a tier may bring in; null means no limit. */
export interface ShipLimits {
  partner: number | null;
  visitor: number | null;
}

/** Hull ids ordered by catalog price, dearest first. */
export function hullsByPrice(): string[] {
  return Object.values(HULLS).sort((a, b) => b.price - a.price || (a.id < b.id ? -1 : 1)).map((h) => h.id);
}

/**
 * The default class limits as hull ids: partners may bring any hull, visitors anything but the
 * two most expensive hulls of the catalog.
 */
export function defaultShipLimit(): { partner: string | null; visitor: string | null } {
  const byPrice = hullsByPrice();
  return { partner: null, visitor: byPrice[Math.min(2, byPrice.length - 1)] ?? null };
}

/** The price cap that applies to a ship from a server of this (effective) tier. */
export function shipLimitFor(tier: TrustLevel, limits: ShipLimits | null | undefined): number | null {
  if (tier === 'union' || !limits) return null;
  const cap = tier === 'partner' ? limits.partner : limits.visitor;
  return typeof cap === 'number' && Number.isFinite(cap) ? cap : null;
}

/** Whether a hull is within a price cap. An unknown hull never is, unless there is no cap. */
export function hullAllowed(hullId: string, maxPrice: number | null): boolean {
  if (maxPrice === null) return true;
  return Object.hasOwn(HULLS, hullId) && HULLS[hullId]!.price <= maxPrice;
}

/** The dearest hull that fits under a price cap, for messages; null when none does. */
export function largestHullWithin(maxPrice: number): string | null {
  return hullsByPrice().find((id) => HULLS[id]!.price <= maxPrice) ?? null;
}
