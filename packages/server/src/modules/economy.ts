/**
 * Station economy: commodity markets, refuelling, repairs, outfitting and the shipyard.
 *
 * A market is derived from the economy type of its site. Every commodity row has a stock that
 * trades move and that drifts back to its target over universe time; the price follows the stock.
 * Nothing here creates credits: every purchase costs at least what the same item refunds.
 */
import {
  COMMODITIES,
  ECONOMIES,
  FlightMode,
  HULLS,
  MODULES,
  cargoTonnes,
  computeShipStats,
  findSite,
  normalizeLoadout,
  rngFor,
  starterLoadout,
  type Loadout,
  type MarketRow,
  type SellResult,
  type SiteDef,
  type StationService,
  type SystemDef,
} from '@primacy2/shared';
import { fail, ok, type GameModule, type Player } from '../game.ts';
import { isHullBound, isSlotBound, markShipLocal, markSlotLocal } from '../trade.ts';
import type { World } from '../world.ts';

// ---------------------------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------------------------

/** Price multiplier bounds around the commodity base price (before the spread). */
export const PRICE_MIN = 0.35;
export const PRICE_MAX = 3;
/** Steepness of the price curve. */
const CURVE_POWER = 1.5;
/** Chosen so the multiplier is exactly 1 when the stock equals the row's reference stock. */
const CURVE_A = (PRICE_MAX - PRICE_MIN) / (1 - PRICE_MIN) - 1;
/** Half the distance between the buy and the sell price, as a fraction of the mid price. */
export const SPREAD = 0.06;
/** Time constant with which a stock returns to its target, universe seconds. */
const RECOVERY_SECONDS = 8 * 3600;
/** A market that was not updated for longer catches up by at most this much, universe seconds. */
const MAX_CATCH_UP_SECONDS = 3 * 86_400;
/** `worldTick` writes a recovering market to the store at most this often, universe seconds. */
const SAVE_INTERVAL_SECONDS = 60;
/** Share of the catalog price paid back for a replaced module or a traded-in hull. */
export const TRADE_IN = 0.8;
/** Tariff shown for cargo whose origin is a visitor or blocked server. Such cargo counts as sealed and cannot be sold. */
export const RESTRICTED_TARIFF = 0.9;
/** Upper bound for one order; keeps the per-tonne price loop short whatever a client sends. */
const MAX_ORDER = 100_000;
/** Credits per tonne of fuel at an ordinary station. */
const FUEL_PRICE = 40;
/** Goods every market trades at about the base price unless its economy says otherwise. */
const STAPLES = ['food', 'water', 'fuel_cells', 'medicine'];

// ---------------------------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------------------------

interface Row {
  c: string;
  /** Catalog base price per tonne. */
  base: number;
  /** Stock at which the mid price equals the base price. */
  ref: number;
  /** Stock the row drifts back to. Above `ref` for produced goods, below it for consumed goods. */
  target: number;
  /** Tonnes in store; fractional because recovery is continuous. */
  stock: number;
}

interface Market {
  key: string;
  /** Universe time of the last recovery step. */
  t: number;
  /** Universe time of the last write to the store. */
  savedAt: number;
  /** Stocks have moved since the last write. */
  dirty: boolean;
  rows: Map<string, Row>;
}

/** Stored form: only what cannot be derived again from the site seed. */
interface MarketDoc {
  v: 1;
  t: number;
  stock: Record<string, number>;
}

/** Loaded markets per world. The module object is shared by every server in a process. */
const loaded = new WeakMap<World, Map<string, Market>>();

function marketsOf(world: World): Map<string, Market> {
  let m = loaded.get(world);
  if (!m) loaded.set(world, (m = new Map()));
  return m;
}

/** Whether a site trades small volumes: outposts and anything that is not a full station. */
const isSmall = (site: SiteDef): boolean => site.kind !== 'station' || site.economy === 'outpost';

/**
 * Builds the rows of a site's market at equilibrium. The result depends only on the system and
 * the site definition, so a market can be rebuilt at any time and on any run.
 */
function buildRows(system: SystemDef, site: SiteDef): Map<string, Row> {
  const eco = ECONOMIES[site.economy ?? 'outpost'] ?? ECONOMIES.outpost;
  const rng = rngFor(site.seed, 'market');
  const small = isSmall(site);
  const size = (small ? 0.35 : 1) * rng.range(0.8, 1.25);
  const rows = new Map<string, Row>();
  for (const def of Object.values(COMMODITIES)) {
    // One draw per catalog entry, used or not, so a row never depends on which other rows exist.
    const vary = rng.float();
    const made = Object.hasOwn(eco.produces, def.id) ? eco.produces[def.id]! : 0;
    const used = Object.hasOwn(eco.consumes, def.id) ? eco.consumes[def.id]! : 0;
    let ref: number;
    let ratio: number;
    if (def.illegal) {
      // Contraband is only traded outside secure space, in small amounts and at a premium.
      if (system.security === 'secure') continue;
      ref = size * 12;
      ratio = 0.4 + 0.2 * vary;
    } else if (made > 0) {
      ref = size * (20 + made * 2);
      ratio = 1.8 + 0.6 * vary;
    } else if (used > 0) {
      ref = size * (20 + used * 3);
      ratio = 0.38 + 0.2 * vary;
    } else if (STAPLES.includes(def.id)) {
      ref = size * 80;
      ratio = 0.9 + 0.25 * vary;
    } else if (!small) {
      // Full stations deal in everything else in small lots, so no legal cargo is a dead end.
      ref = size * 16;
      ratio = 0.95 + 0.3 * vary;
    } else {
      continue;
    }
    ref = Math.max(6, Math.round(ref));
    const target = Math.max(2, Math.round(ref * ratio));
    rows.set(def.id, { c: def.id, base: def.price, ref, target, stock: target });
  }
  return rows;
}

function saveMarket(world: World, m: Market): void {
  const stock: Record<string, number> = {};
  for (const row of m.rows.values()) stock[row.c] = Math.round(row.stock * 1000) / 1000;
  const doc: MarketDoc = { v: 1, t: m.t, stock };
  world.store.putDoc('market', m.key, doc);
  m.savedAt = m.t;
  m.dirty = false;
}

/** Moves every stock toward its target by the universe time since the last step. Returns whether anything moved. */
function recover(m: Market, now: number): boolean {
  const dt = now - m.t;
  m.t = now;
  if (!(dt > 0)) return false;
  const k = 1 - Math.exp(-Math.min(dt, MAX_CATCH_UP_SECONDS) / RECOVERY_SECONDS);
  let moved = false;
  for (const row of m.rows.values()) {
    const d = (row.target - row.stock) * k;
    if (Math.abs(d) < 1e-9) continue;
    row.stock += d;
    moved = true;
  }
  if (moved) m.dirty = true;
  return moved;
}

/** The market of a site, brought up to the current universe time; null when the site has none. */
function marketOf(world: World, system: SystemDef, site: SiteDef): Market | null {
  if (!site.services?.includes('market')) return null;
  const key = `${system.id}/${site.id}`;
  const all = marketsOf(world);
  const now = world.time();
  let m = all.get(key);
  if (!m) {
    const rows = buildRows(system, site);
    const doc = world.store.getDoc<MarketDoc>('market', key);
    let t = now;
    if (doc && typeof doc === 'object' && doc.stock && typeof doc.stock === 'object' && Number.isFinite(doc.t)) {
      t = Math.min(doc.t, now);
      for (const row of rows.values()) {
        const s = Object.hasOwn(doc.stock, row.c) ? doc.stock[row.c] : undefined;
        if (typeof s === 'number' && Number.isFinite(s) && s >= 0) row.stock = s;
      }
    }
    m = { key, t, savedAt: t, dirty: false, rows };
    all.set(key, m);
    if (!doc) saveMarket(world, m);
  }
  recover(m, now);
  return m;
}

/** Price multiplier for a stock level: smooth, falling, and bounded by PRICE_MIN and PRICE_MAX. */
export function priceFactor(stockOverRef: number): number {
  return PRICE_MIN + (PRICE_MAX - PRICE_MIN) / (1 + CURVE_A * Math.pow(Math.max(0, stockOverRef), CURVE_POWER));
}

const midPrice = (row: Row, stock: number): number => row.base * priceFactor(stock / row.ref);

/** Credits a pilot pays for `n` tonnes: each tonne is priced at the stock it is taken from. */
function buyCost(row: Row, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += midPrice(row, row.stock - i - 0.5);
  return Math.ceil(sum * (1 + SPREAD));
}

/** Credits (before tariff and rounding) the station pays for `n` tonnes added on top of `stock`. */
function sellValue(row: Row, stock: number, n: number): number {
  const whole = Math.floor(n);
  let sum = 0;
  for (let i = 0; i < whole; i++) sum += midPrice(row, stock + i + 0.5);
  // Cargo is kept in whole tonnes; a fractional stack is still never paid as a full tonne.
  const part = n - whole;
  if (part > 0) sum += part * midPrice(row, stock + whole + part / 2);
  return sum * (1 - SPREAD);
}

function marketRow(row: Row): MarketRow {
  const f = priceFactor(row.stock / row.ref);
  const demand = f >= 1 ? (f - 1) / (PRICE_MAX - 1) : (f - 1) / (1 - PRICE_MIN);
  const stock = Math.floor(row.stock);
  return {
    c: row.c,
    stock,
    buy: stock >= 1 ? buyCost(row, 1) : 0,
    sell: Math.floor(sellValue(row, row.stock, 1)),
    demand: Math.round(demand * 100) / 100,
  };
}

/** Share of the sale price withheld for cargo from `origin`. */
function tariffRate(world: World, origin: string): number {
  if (origin === world.id) return 0;
  const tier = world.fed.tierOf(origin);
  if (tier === 'union') return 0;
  if (tier === 'partner') return Math.min(1, Math.max(0, world.config.tariff));
  return RESTRICTED_TARIFF;
}

// ---------------------------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------------------------

const SERVICE_NAME: Record<StationService, string> = {
  market: 'market', outfit: 'outfitter', shipyard: 'shipyard', missions: 'mission board',
  repair: 'repair dock', refuel: 'fuel depot', cartography: 'cartographer',
};

/** The site a pilot is docked at, if it offers `service`; otherwise the refusal text. */
function dockedAt(p: Player, service: StationService): { system: SystemDef; site: SiteDef } | string {
  const ship = p.ship;
  const sim = p.sim;
  if (!ship || !sim || ship.state.mode !== FlightMode.Docked) return 'You must be docked at a station.';
  const site = findSite(sim.def, ship.state.anchor);
  if (!site) return 'You must be docked at a station.';
  if (!site.services?.includes(service)) return `This station has no ${SERVICE_NAME[service]}.`;
  return { system: sim.def, site };
}

const isAmount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

/** Applies a credit change. Callers check affordability first; the floor and clamp are a last guard. */
function addCredits(p: Player, delta: number): void {
  p.rec.credits = Math.max(0, Math.floor(p.rec.credits + delta));
}

function addTradeProfit(p: Player, delta: number): void {
  const stats = p.rec.passport.stats;
  const next = Math.floor((Number.isFinite(stats.tradeProfit) ? stats.tradeProfit : 0) + delta);
  stats.tradeProfit = Math.min(Number.MAX_SAFE_INTEGER, Math.max(-Number.MAX_SAFE_INTEGER, next));
}

function fuelPriceAt(site: SiteDef): number {
  const f = site.economy === 'refinery' ? 0.7 : isSmall(site) ? 1.5 : site.economy === 'mining' ? 1.15 : 1;
  return Math.round(FUEL_PRICE * f);
}

/** Credits per hull point; dearer hulls are dearer to mend. */
const repairRate = (hullId: string): number => 2 + (HULLS[hullId]?.price ?? 0) / 50_000;

function repairCost(p: Player): number {
  if (!p.ship) return 0;
  const damage = p.ship.stats.hullMax - p.ship.state.hull;
  return damage > 1e-6 ? Math.ceil(damage * repairRate(p.ship.stats.hull)) : 0;
}

/** Module ids on sale: tier 1 everywhere, tier 2 at industrial sites, every tier at high-tech and military ones. */
export function modulesSoldAt(site: SiteDef): string[] {
  const eco = site.economy ?? 'outpost';
  const maxTier = eco === 'hightech' || eco === 'military' ? 3 : eco === 'industrial' ? 2 : 1;
  return Object.values(MODULES).filter((m) => m.tier <= maxTier).map((m) => m.id);
}

/** Hull that suits the local trade and is always in a small yard's range. */
const YARD_HULL: Record<string, string> = {
  agri: 'drover', mining: 'delver', refinery: 'drover', industrial: 'drover', hightech: 'wayfarer',
  military: 'lancet', outpost: 'lancet',
};

/**
 * Hull ids on sale. The capital and every full station sell all hulls; a smaller site that was
 * given a shipyard sells the starter hull, the hull that suits its economy and one more by seed.
 */
export function hullsSoldAt(world: World, system: SystemDef, site: SiteDef): string[] {
  const all = Object.keys(HULLS);
  const capital = world.capital();
  if (capital.system.id === system.id && capital.site.id === site.id) return all;
  if (site.kind === 'station') return all;
  const pick = new Set<string>(['wisp', YARD_HULL[site.economy ?? 'outpost'] ?? 'lancet']);
  pick.add(rngFor(site.seed, 'shipyard').pick(all));
  return all.filter((id) => pick.has(id));
}

const modulePrice = (id: string | null | undefined): number => (id && Object.hasOwn(MODULES, id) ? MODULES[id]!.price : 0);

/** What a hull costs at the yard: the hull itself plus the stock modules it is delivered with. */
export function hullPrice(hullId: string): number {
  const hull = HULLS[hullId];
  if (!hull) return 0;
  return hull.price + hull.stock.reduce((sum, id) => sum + modulePrice(id), 0);
}

// ---------------------------------------------------------------------------------------------
// Customs: equipment that arrived from a server outside the customs union
// ---------------------------------------------------------------------------------------------

/**
 * The core records in `rec.data.customs` which parts of a ship that arrived from another server
 * are bound: they were not paid for here and refund nothing (see `shipBinding` in trade.ts).
 * This module clears the mark of a slot when the pilot fits something there, and of the whole
 * ship when the pilot buys a hull, so only what was bought here is refundable.
 */

/** Credits paid back for the hull. */
const hullRefund = (p: Player, cur: Loadout): number => (isHullBound(p.rec) ? 0 : Math.floor(HULLS[cur.hull]!.price * TRADE_IN));

/** Credits paid back for the module in `slot`. */
const moduleRefund = (p: Player, cur: Loadout, slot: number): number =>
  isSlotBound(p.rec, slot) ? 0 : Math.floor(modulePrice(cur.modules[slot]) * TRADE_IN);

// ---------------------------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------------------------

export const economyModule: GameModule = {
  name: 'economy',

  init(world) {
    // Load every stored market so `worldTick` keeps all of them moving, visited or not.
    for (const { id } of world.store.listDocs<MarketDoc>('market')) {
      const cut = id.lastIndexOf('/');
      const system = world.defs.get(id.slice(0, cut));
      const site = system && findSite(system, Number(id.slice(cut + 1)));
      if (system && site) marketOf(world, system, site);
    }
  },

  worldTick(world) {
    const now = world.time();
    for (const m of marketsOf(world).values()) {
      recover(m, now);
      if (m.dirty && now - m.savedAt >= SAVE_INTERVAL_SECONDS) saveMarket(world, m);
    }
  },

  stationView(p, sim, siteId, view) {
    const site = findSite(sim.def, siteId);
    if (!site) return;
    const world = sim.world;
    const services = site.services ?? [];
    const market = marketOf(world, sim.def, site);
    if (market) view.market = [...market.rows.values()].map(marketRow);
    if (services.includes('refuel')) view.fuelPrice = fuelPriceAt(site);
    if (services.includes('repair')) view.repairPrice = repairCost(p);
    if (services.includes('outfit')) view.modules = modulesSoldAt(site);
    if (services.includes('shipyard')) view.hulls = hullsSoldAt(world, sim.def, site);
    for (const item of p.rec.passport.ship.cargo) {
      if (item.origin === world.id || item.origin === '__proto__') continue;
      view.tariffs[item.origin] = tariffRate(world, item.origin);
    }
  },

  commands: {
    buy(p, cmd, world) {
      const at = dockedAt(p, 'market');
      if (typeof at === 'string') return fail(at);
      if (typeof cmd.c !== 'string' || !Object.hasOwn(COMMODITIES, cmd.c)) return fail('Unknown commodity.');
      const n = cmd.n;
      if (!isAmount(n) || n > MAX_ORDER) return fail('The amount must be a whole number of tonnes.');
      const market = marketOf(world, at.system, at.site)!;
      const row = market.rows.get(cmd.c);
      if (!row) return fail('This station does not trade that.');
      const stock = Math.floor(row.stock);
      if (n > stock) return fail(stock > 0 ? `Only ${stock} t in stock.` : 'Out of stock.');
      if (n > p.cargoFree()) return fail('Not enough cargo space.');
      const cost = buyCost(row, n);
      if (cost > p.rec.credits) return fail('Not enough credits.');
      const added = p.addCargo(row.c, n, world.id, false);
      if (added !== n) {
        // Cannot happen after the space check; undo rather than charge for cargo not delivered.
        p.removeCargo(row.c, added);
        return fail('Not enough cargo space.');
      }
      row.stock -= n;
      addCredits(p, -cost);
      addTradeProfit(p, -cost);
      saveMarket(world, market);
      world.pushPilot(p);
      world.pushStation(p);
      return ok({ n, total: cost });
    },

    sell(p, cmd, world) {
      const at = dockedAt(p, 'market');
      if (typeof at === 'string') return fail(at);
      if (typeof cmd.c !== 'string' || !Object.hasOwn(COMMODITIES, cmd.c)) return fail('Unknown commodity.');
      const n = cmd.n;
      if (!isAmount(n) || n > MAX_ORDER) return fail('The amount must be a whole number of tonnes.');
      if (COMMODITIES[cmd.c]!.illegal && at.system.security === 'secure') return fail('That is contraband here.');
      const market = marketOf(world, at.system, at.site)!;
      const row = market.rows.get(cmd.c);
      if (!row) return fail('This station does not trade that.');
      if (n > p.cargoCount(row.c)) return fail('You do not carry that much.');
      // The trade books decide how much of it may be sold here: sealed cargo never, imports only
      // within the partner's trade balance and the pilot's licence. What passes leaves the hold.
      const taken = world.trade.takeCargo(p, row.c, n);
      if (taken.n <= 0) return fail(world.trade.explain(taken.limit, taken.limitOrigin, p), { limit: taken.limit, limitOrigin: taken.limitOrigin });
      // Each stack is priced where the previous one left the stock, then taxed by its origin.
      let stock = row.stock;
      let gross = 0;
      let net = 0;
      let sold = 0;
      for (const stack of taken.lots) {
        const value = sellValue(row, stock, stack.n);
        stock += stack.n;
        sold += stack.n;
        gross += value;
        net += value * (1 - tariffRate(world, stack.origin));
      }
      const pay = Math.floor(net);
      row.stock = stock;
      addCredits(p, pay);
      addTradeProfit(p, pay);
      saveMarket(world, market);
      world.pushPilot(p);
      world.pushStation(p);
      if (taken.limit) p.notice('warn', 'sale_limited', `Only ${sold} t sold. ${world.trade.explain(taken.limit, taken.limitOrigin, p)}`);
      return ok({
        n: sold, total: pay, tariff: Math.floor(gross) - pay, limit: taken.limit, limitOrigin: taken.limitOrigin,
      } satisfies SellResult);
    },

    refuel(p, _cmd, world) {
      const at = dockedAt(p, 'refuel');
      if (typeof at === 'string') return fail(at);
      const ship = p.ship!;
      const need = ship.stats.fuelCap - ship.state.fuel;
      if (!(need > 1e-6)) return fail('The tank is full.');
      const price = fuelPriceAt(at.site);
      let tonnes = need;
      let cost = Math.ceil(need * price);
      if (cost > p.rec.credits) {
        // Short of credits: spend what there is.
        cost = Math.max(0, Math.floor(p.rec.credits));
        tonnes = cost / price;
      }
      if (cost <= 0) return fail('Not enough credits.');
      ship.state.fuel = Math.min(ship.stats.fuelCap, ship.state.fuel + tonnes);
      addCredits(p, -cost);
      world.pushPilot(p);
      world.pushStation(p);
      return ok({ tonnes, cost });
    },

    repair(p, _cmd, world) {
      const at = dockedAt(p, 'repair');
      if (typeof at === 'string') return fail(at);
      const ship = p.ship!;
      const damage = ship.stats.hullMax - ship.state.hull;
      if (!(damage > 1e-6)) return fail('The hull is undamaged.');
      const rate = repairRate(ship.stats.hull);
      let points = damage;
      let cost = Math.ceil(damage * rate);
      if (cost > p.rec.credits) {
        cost = Math.max(0, Math.floor(p.rec.credits));
        points = cost / rate;
      }
      if (cost <= 0) return fail('Not enough credits.');
      ship.state.hull = Math.min(ship.stats.hullMax, ship.state.hull + points);
      addCredits(p, -cost);
      world.pushPilot(p);
      world.pushStation(p);
      return ok({ points, cost });
    },

    fit(p, cmd, world) {
      const at = dockedAt(p, 'outfit');
      if (typeof at === 'string') return fail(at);
      const cur = normalizeLoadout(p.rec.passport.ship.loadout);
      const hull = HULLS[cur.hull]!;
      const slot = cmd.slot;
      if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot >= hull.slots.length) return fail('No such slot.');
      const slotType = hull.slots[slot]!;
      const wanted = cmd.module;
      const old = cur.modules[slot] ?? null;
      let price = 0;
      if (wanted === null) {
        if (slotType !== 'weapon' && slotType !== 'utility') return fail('That slot cannot be left empty.');
        if (old === null) return fail('That slot is already empty.');
      } else {
        if (typeof wanted !== 'string' || !Object.hasOwn(MODULES, wanted)) return fail('Unknown module.');
        const def = MODULES[wanted]!;
        if (def.slot !== slotType) return fail('That module does not fit this slot.');
        if (!modulesSoldAt(at.site).includes(def.id)) return fail('That module is not sold here.');
        if (old === def.id) return fail('That module is already fitted.');
        price = def.price;
      }
      const refund = moduleRefund(p, cur, slot);
      if (p.rec.credits + refund < price) return fail('Not enough credits.');
      const next: Loadout = { hull: cur.hull, modules: cur.modules.map((id, i) => (i === slot ? wanted : id)) };
      if (Math.floor(computeShipStats(next).cargoCap) < cargoTonnes(p.rec.passport.ship.cargo)) {
        return fail('Your cargo would no longer fit. Sell some first.');
      }
      addCredits(p, refund - price);
      // Whatever sits in this slot from now on was bought here (or the slot is empty).
      markSlotLocal(p.rec, slot);
      p.rec.passport.ship.loadout = next;
      p.refit();
      world.pushPilot(p);
      world.pushStation(p);
      world.save(p);
      return ok({ cost: price, refund });
    },

    buyHull(p, cmd, world) {
      const at = dockedAt(p, 'shipyard');
      if (typeof at === 'string') return fail(at);
      if (typeof cmd.hull !== 'string' || !Object.hasOwn(HULLS, cmd.hull)) return fail('Unknown hull.');
      const hull = HULLS[cmd.hull]!;
      if (!hullsSoldAt(world, at.system, at.site).includes(hull.id)) return fail('That hull is not sold here.');
      const cur = normalizeLoadout(p.rec.passport.ship.loadout);
      if (cur.hull === hull.id) return fail('You already fly that hull.');
      let tradeIn = hullRefund(p, cur);
      for (let i = 0; i < cur.modules.length; i++) tradeIn += moduleRefund(p, cur, i);
      const price = hullPrice(hull.id);
      if (p.rec.credits + tradeIn < price) return fail(`Not enough credits: ${price - tradeIn} needed after trade-in.`);
      const next = starterLoadout(hull.id);
      if (Math.floor(computeShipStats(next).cargoCap) < cargoTonnes(p.rec.passport.ship.cargo)) {
        return fail('Your cargo would not fit the new hull. Sell some first.');
      }
      addCredits(p, tradeIn - price);
      // The whole ship was bought here; nothing that arrived is left on it.
      markShipLocal(p.rec);
      p.rec.passport.ship.loadout = next;
      p.refit();
      if (p.ship) {
        // A new hull is delivered intact and fuelled.
        p.ship.state.hull = p.stats.hullMax;
        p.ship.state.fuel = p.stats.fuelCap;
        p.ship.state.shield = p.stats.shieldMax;
        p.ship.state.energy = p.stats.energyMax;
      }
      world.pushPilot(p);
      world.pushStation(p);
      world.save(p);
      return ok({ cost: price, tradeIn });
    },
  },
};
