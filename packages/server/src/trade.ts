/**
 * This server's own books for trade with other servers, and the one place that decides whether
 * cargo may be turned into value here.
 *
 * - The ledger: per peer, the trade units exported to it and imported from it.
 * - The import licence: per pilot, the non-trade income earned here and the imports absorbed for it.
 * - `takeCargo` / `absorb`: every command that turns cargo into credits, mission progress, gate
 *   progress or anything else of value must take the cargo through one of them.
 * - Ship binding: which hull and modules of a pilot's ship were not paid for here.
 *
 * The rules themselves are pure functions in `@primacy2/shared` (trade.ts).
 */
import {
  HULLS,
  absorbable,
  cargoTradeUnits,
  lotStatus,
  normalizeLoadout,
  remainingAllowance,
  remainingLicence,
  tradeUnits,
  type AbsorbLimit,
  type CargoItem,
  type DepartedShip,
  type ImportInfo,
  type LicenceAccount,
  type Loadout,
  type LotStatus,
  type ShipBinding,
  type ShipLimits,
  type TradeLedger,
  type TrustLevel,
} from '@primacy2/shared';
import type { ServerConfig } from './config.ts';
import type { Player } from './game.ts';
import type { PlayerRecord } from './store.ts';
import type { World } from './world.ts';

/** Where non-trade income came from. All of them count towards the import licence alike. */
export type IncomeSource = 'mission' | 'bounty' | 'data' | 'mining';

/** The verdict on one lot handed to `absorb`. */
export interface AbsorbedLot {
  c: string;
  /** Tonnes that were asked for. */
  n: number;
  origin: string;
  status: LotStatus;
  /** Tonnes that may be turned into value. */
  take: number;
  /** Why `take` is smaller than `n`, or null when the lot passed in full. */
  limit: AbsorbLimit | null;
}

export interface AbsorbResult {
  /** Index-aligned with the lots that were passed in. */
  lots: AbsorbedLot[];
  /** Total tonnes that may be turned into value. */
  n: number;
  /** The first limit that cut a lot short, or null. */
  limit: AbsorbLimit | null;
  /** Origin of the lot that hit `limit`. */
  limitOrigin: string | null;
}

export interface TakeResult {
  /** The lots removed from the hold, with their origins. Never contains sealed cargo. */
  lots: CargoItem[];
  /** Total tonnes removed. */
  n: number;
  /**
   * Why fewer tonnes than asked for were taken: the cargo is sealed, the partner's trade balance
   * is exhausted, the pilot's import licence is used up, or the pilot does not carry that much.
   */
  limit: AbsorbLimit | 'missing' | null;
  /** Origin of the lot that hit `limit`. */
  limitOrigin: string | null;
}

/** What is left to spend while a batch of lots is being judged. */
interface Budget {
  licence: number;
  allowance: Map<string, number>;
}

interface Planned {
  lot: CargoItem;
  status: LotStatus;
  take: number;
  limit: AbsorbLimit | null;
  /** Trade units the take costs the partner's allowance and the pilot's licence. */
  value: number;
}

const ORDER: Record<LotStatus, number> = { local: 0, free: 1, import: 2, sealed: 3 };

export class TradeBook {
  private readonly ledgers = new Map<string, TradeLedger>();

  constructor(private readonly world: World) {}

  // -------------------------------------------------------------------------------------------
  // Ledger
  // -------------------------------------------------------------------------------------------

  /** This server's books for one peer, in trade units. */
  ledger(peer: string): Readonly<TradeLedger> {
    return this.row(peer);
  }

  private row(peer: string): TradeLedger {
    let l = this.ledgers.get(peer);
    if (!l) {
      l = this.world.store.loadLedger(peer);
      this.ledgers.set(peer, l);
    }
    return l;
  }

  /** Whether an active warp gate of this sector leads to `peer`. */
  private gateTo(peer: string): boolean {
    for (const def of this.world.defs.values()) {
      for (const site of def.sites) if (site.gate && site.gate.peer === peer && site.gate.state === 'active') return true;
    }
    return false;
  }

  /** Trade units a partner may be in deficit: the configured line plus the bonus while a gate links the two. */
  creditLine(peer: string): number {
    const cfg = this.world.config;
    const own = Object.hasOwn(cfg.tradeCredits, peer) ? cfg.tradeCredits[peer]! : cfg.tradeCredit;
    return own + (this.gateTo(peer) ? cfg.gateTradeCredit : 0);
  }

  /**
   * Trade units of imports from `peer` that can still be absorbed: null when unlimited (this
   * server itself and customs union members), 0 for visitors and blocked servers.
   */
  allowance(peer: string): number | null {
    if (peer === this.world.id) return null;
    const tier = this.world.fed.tierOf(peer);
    if (tier === 'union') return null;
    if (tier !== 'partner') return 0;
    return remainingAllowance(this.row(peer), this.creditLine(peer));
  }

  /**
   * Books the local, unsealed cargo of a departed ship as an export to `peer`. Call only when the
   * peer has redeemed the ticket. Returns the trade units booked.
   */
  bookExport(peer: string, cargo: readonly CargoItem[]): number {
    const value = cargoTradeUnits(cargo.filter((it) => it.origin === this.world.id && !it.sealed));
    if (value > 0) {
      const l = this.row(peer);
      l.exports += value;
      this.world.store.saveLedger(peer, l);
    }
    return value;
  }

  /** Takes back an export that turned out not to have left (the ship was recalled). */
  unbookExport(peer: string, value: number): void {
    if (!(value > 0)) return;
    const l = this.row(peer);
    l.exports = Math.max(0, l.exports - value);
    this.world.store.saveLedger(peer, l);
  }

  // -------------------------------------------------------------------------------------------
  // Import licence
  // -------------------------------------------------------------------------------------------

  private account(rec: PlayerRecord): LicenceAccount {
    const d = rec.data.trade as Partial<LicenceAccount> | undefined;
    if (d && typeof d === 'object' && Number.isFinite(d.income) && Number.isFinite(d.used)) return d as LicenceAccount;
    const fresh: LicenceAccount = { income: 0, used: 0 };
    rec.data.trade = fresh;
    return fresh;
  }

  /** The pilot's import licence in trade units: what it allows in total and what has been used. */
  licence(p: Player): { cap: number; used: number } {
    const a = this.account(p.rec);
    return { cap: Math.max(0, a.income) * this.world.config.importLicenceRate, used: a.used };
  }

  /**
   * Credits non-trade income to the pilot's import licence. `amount` is in credits, or in trade
   * units for ore the pilot mined. Call it wherever a pilot is paid for something other than
   * selling cargo; never for trade revenue, refunds or returned deposits.
   */
  creditIncome(p: Player, amount: number, _source: IncomeSource): void {
    if (!Number.isFinite(amount) || !(amount > 0)) return;
    this.account(p.rec).income += amount;
  }

  // -------------------------------------------------------------------------------------------
  // Absorbing cargo
  // -------------------------------------------------------------------------------------------

  private statusOf(lot: Pick<CargoItem, 'origin' | 'sealed'>): LotStatus {
    return lotStatus(lot, this.world.id, (id) => this.world.fed.tierOf(id));
  }

  private budget(p: Player): Budget {
    return { licence: remainingLicence(this.account(p.rec), this.world.config.importLicenceRate), allowance: new Map() };
  }

  /** Judges one lot against what is left of the budget and reserves what it takes. */
  private plan(lot: CargoItem, budget: Budget): Planned {
    const status = this.statusOf(lot);
    if (status !== 'import') {
      const res = absorbable(lot.c, lot.n, status, 0, 0);
      return { lot, status, take: res.n, limit: res.limit, value: 0 };
    }
    const left = budget.allowance.get(lot.origin) ?? remainingAllowance(this.row(lot.origin), this.creditLine(lot.origin));
    const res = absorbable(lot.c, lot.n, status, left, budget.licence);
    const value = tradeUnits(lot.c, res.n);
    budget.allowance.set(lot.origin, left - value);
    budget.licence -= value;
    return { lot, status, take: res.n, limit: res.limit, value };
  }

  /** Writes planned imports into the ledger and the pilot's licence. */
  private book(p: Player, plans: readonly Planned[]): void {
    const touched = new Set<string>();
    for (const pl of plans) {
      if (pl.status !== 'import' || !(pl.value > 0)) continue;
      this.row(pl.lot.origin).imports += pl.value;
      this.account(p.rec).used += pl.value;
      touched.add(pl.lot.origin);
    }
    for (const peer of touched) this.world.store.saveLedger(peer, this.row(peer));
  }

  /**
   * The absorb check. Given the lots about to be turned into value for a pilot, says how many
   * tonnes of each may be and why not more, and books the imports and the licence use for what
   * passes. Local lots and customs union lots pass untouched; sealed lots never pass.
   * With `book: false` nothing is written (a preview).
   *
   * The caller must consume exactly `take` tonnes of each lot. Commands that take cargo from a
   * pilot's hold should use `takeCargo`, which selects, books and removes in one step.
   */
  absorb(p: Player, lots: readonly CargoItem[], opts: { book?: boolean } = {}): AbsorbResult {
    const budget = this.budget(p);
    const plans = lots.map((lot) => this.plan(lot, budget));
    if (opts.book !== false) this.book(p, plans);
    const cut = plans.find((pl) => pl.limit !== null);
    return {
      lots: plans.map((pl) => ({ c: pl.lot.c, n: pl.lot.n, origin: pl.lot.origin, status: pl.status, take: pl.take, limit: pl.limit })),
      n: plans.reduce((sum, pl) => sum + pl.take, 0),
      limit: cut?.limit ?? null,
      limitOrigin: cut?.lot.origin ?? null,
    };
  }

  /**
   * Takes up to `n` tonnes of a commodity out of the pilot's hold to be turned into value, and
   * books what that absorbs. Local goods go first, then customs union goods, then imports as far
   * as the partner's trade balance and the pilot's licence allow; sealed cargo is never taken.
   * With `exact`, either all `n` tonnes are taken or nothing is taken and nothing is booked.
   */
  takeCargo(p: Player, c: string, n: number, opts: { exact?: boolean } = {}): TakeResult {
    const hold = p.rec.passport.ship.cargo;
    const want = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    const stacks = hold
      .filter((it) => it.c === c && it.n > 0)
      .map((it) => ({ it, status: this.statusOf(it) }))
      .sort((a, b) => ORDER[a.status] - ORDER[b.status]);
    const budget = this.budget(p);
    const plans: { stack: CargoItem; plan: Planned }[] = [];
    let left = want;
    let limit: TakeResult['limit'] = null;
    let limitOrigin: string | null = null;
    for (const { it } of stacks) {
      if (left <= 0) break;
      const ask = Math.min(left, it.n);
      const plan = this.plan(it.sealed ? { c, n: ask, origin: it.origin, sealed: true } : { c, n: ask, origin: it.origin }, budget);
      if (plan.limit && !limit) {
        limit = plan.limit;
        limitOrigin = it.origin;
      }
      left -= plan.take;
      if (plan.take > 0) plans.push({ stack: it, plan });
    }
    if (left > 0 && !limit) limit = 'missing';
    if (left <= 0) {
      limit = null;
      limitOrigin = null;
    }
    if (opts.exact && left > 0) return { lots: [], n: 0, limit, limitOrigin };

    this.book(p, plans.map((x) => x.plan));
    const lots: CargoItem[] = [];
    for (const { stack, plan } of plans) {
      stack.n -= plan.take;
      lots.push({ c, n: plan.take, origin: stack.origin });
      if (stack.n <= 0) hold.splice(hold.indexOf(stack), 1);
    }
    return { lots, n: want - left, limit, limitOrigin };
  }

  /** Words for a pilot whose cargo was not, or not fully, taken. */
  explain(limit: TakeResult['limit'], origin: string | null): string {
    const name = origin ? (this.world.fed.known.get(origin)?.desc.name ?? origin.slice(0, 6)) : 'that sector';
    switch (limit) {
      case 'sealed':
        return 'That cargo is sealed in this sector: it can be carried out again or jettisoned, nothing else.';
      case 'allowance':
        return `The trade balance with ${name} is exhausted: this sector takes no more of its goods until more has been exported there.`;
      case 'licence':
        return 'Your import licence is used up. Missions, bounties, survey data and mining in this sector extend it.';
      case 'missing':
        return 'You do not carry that much.';
      default:
        return '';
    }
  }

  // -------------------------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------------------------

  /** Per origin, what the foreign and sealed cargo in the pilot's hold counts as here. */
  importInfo(p: Player): ImportInfo[] {
    const rows = new Map<string, ImportInfo>();
    for (const it of p.rec.passport.ship.cargo) {
      const status = this.statusOf(it);
      if (status === 'local') continue;
      let row = rows.get(it.origin);
      if (!row) {
        const own = it.origin === this.world.id;
        row = {
          origin: it.origin,
          name: own ? this.world.config.name : (this.world.fed.known.get(it.origin)?.desc.name ?? it.origin.slice(0, 6)),
          tier: this.world.fed.tierOf(it.origin),
          allowance: this.allowance(it.origin),
          tonnes: 0,
          sealed: 0,
        };
        rows.set(it.origin, row);
      }
      row.tonnes += it.n;
      if (status === 'sealed') row.sealed += it.n;
    }
    return [...rows.values()];
  }
}

// ---------------------------------------------------------------------------------------------
// Ship binding
// ---------------------------------------------------------------------------------------------

/**
 * `rec.data.customs`, written by the core whenever a ship arrives from another server.
 * `bound` says which parts were not paid for here; the economy clears entries as the pilot
 * buys replacements. A pilot who never arrived from elsewhere has no record and nothing bound.
 */
export interface CustomsRecord {
  issuer: string;
  /** Effective tier of the issuer at arrival. */
  trust: TrustLevel;
  at: number;
  /** The loadout the ship arrived with. */
  loadout: Loadout;
  bound: ShipBinding;
}

/**
 * The binding of the pilot's current ship, or null when nothing was ever bound. A record without
 * a usable `bound` field (written by an older version, or damaged) is read as: everything is
 * bound unless a customs union member issued the ship.
 */
export function shipBinding(rec: PlayerRecord): ShipBinding | null {
  const customs = rec.data.customs as (Partial<CustomsRecord> & { bought?: { hull?: unknown; slots?: unknown } }) | undefined;
  if (!customs || typeof customs !== 'object') return null;
  const b = customs.bound as Partial<ShipBinding> | undefined;
  if (b && typeof b === 'object' && typeof b.hull === 'boolean' && Array.isArray(b.slots)) return b as ShipBinding;
  const trust = customs.trust as string | undefined;
  const bought = customs.bought && typeof customs.bought === 'object' ? customs.bought : null;
  const free = trust === 'union' || trust === 'trusted' || bought?.hull === true;
  const count = normalizeLoadout(rec.passport.ship.loadout).modules.length;
  const fresh: ShipBinding = {
    hull: !free,
    slots: Array.from({ length: count }, (_, i) => !free && !(Array.isArray(bought?.slots) && bought.slots[i] === true)),
  };
  customs.bound = fresh;
  return fresh;
}

/** Whether the hull refunds nothing here and yields no scrap as a wreck. */
export function isHullBound(rec: PlayerRecord): boolean {
  return shipBinding(rec)?.hull === true;
}

/** Whether the module in `slot` refunds nothing here and yields no part as a wreck. */
export function isSlotBound(rec: PlayerRecord, slot: number): boolean {
  const b = shipBinding(rec);
  return !!b && (b.slots[slot] ?? b.hull) === true;
}

/** The binding with one entry per slot of the current hull, for views and for the transfer ticket. */
export function fullBinding(rec: PlayerRecord): ShipBinding | null {
  const b = shipBinding(rec);
  if (!b) return null;
  const count = normalizeLoadout(rec.passport.ship.loadout).modules.length;
  return { hull: b.hull, slots: Array.from({ length: count }, (_, i) => (b.slots[i] ?? b.hull) === true) };
}

/** The bound parts of the pilot's ship, one entry per slot; null when nothing on it is bound. */
export function boundParts(rec: PlayerRecord): ShipBinding | null {
  const b = fullBinding(rec);
  return b && (b.hull || b.slots.includes(true)) ? b : null;
}

/** Whatever sits in `slot` from now on was bought here (or the slot is empty). */
export function markSlotLocal(rec: PlayerRecord, slot: number): void {
  const b = shipBinding(rec);
  if (!b) return;
  for (let i = b.slots.length; i < slot; i++) b.slots[i] = b.hull;
  b.slots[slot] = false;
}

/** The whole ship was bought here: nothing that arrived is left on it. */
export function markShipLocal(rec: PlayerRecord): void {
  const b = shipBinding(rec);
  if (!b) return;
  b.hull = false;
  b.slots = [];
}

/** Remembers the ship a pilot leaves with, so it can be recognised when it comes back. */
export function recordDeparture(rec: PlayerRecord): void {
  const lo = normalizeLoadout(rec.passport.ship.loadout);
  const bound = fullBinding(rec) ?? { hull: false, slots: lo.modules.map(() => false) };
  rec.data.departed = { hull: lo.hull, modules: [...lo.modules], bound } satisfies DepartedShip;
}

/** The ship the pilot last left with, or null when there is no usable record. */
export function departedShip(rec: PlayerRecord): DepartedShip | null {
  const d = rec.data.departed as Partial<DepartedShip> | undefined;
  if (!d || typeof d !== 'object' || typeof d.hull !== 'string' || !Array.isArray(d.modules)) return null;
  const b = d.bound;
  if (!b || typeof b !== 'object' || typeof b.hull !== 'boolean' || !Array.isArray(b.slots)) return null;
  return d as DepartedShip;
}

/** The configured class limits (hull ids) as the price caps a descriptor publishes. */
export function shipLimitPrices(config: ServerConfig): ShipLimits {
  const price = (id: string | null): number | null => (id !== null && Object.hasOwn(HULLS, id) ? HULLS[id]!.price : null);
  return { partner: price(config.shipLimit.partner), visitor: price(config.shipLimit.visitor) };
}
