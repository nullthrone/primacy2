/**
 * Economy module: markets, tariffs, station services, outfitting, the shipyard and the customs rule.
 * One real server on a manually advanced clock; commands go through `world.handleCommand`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMODITIES,
  ECONOMIES,
  FlightMode,
  HULLS,
  MODULES,
  Rng,
  cargoTonnes,
  starterLoadout,
  type Command,
  type Loadout,
  type MarketRow,
  type SiteDef,
  type StationService,
  type StationView,
  type SystemDef,
} from '@primacy2/shared';
import type { CommandResult, Player, PrimacyServer } from '@primacy2/server';
import { Bot } from './bot.ts';
import { Cluster } from './harness.ts';

interface Place {
  system: SystemDef;
  site: SiteDef;
}

const c = new Cluster();
let S: PrimacyServer;
let capital: Place;
let pilots = 0;
/** Market rows of every site as first seen, before any test traded there. */
const baseline = new Map<string, MarketRow[]>();

const keyOf = (pl: Place): string => `${pl.system.id}/${pl.site.id}`;
const cmd = (p: Player, command: Command): Promise<CommandResult> => S.world.handleCommand(p, command);
const errOf = (r: CommandResult): string => (r.ok ? '' : r.err);
const dataOf = <T>(r: CommandResult): T => {
  if (!r.ok) throw new Error(`command failed: ${r.err}`);
  return r.data as T;
};

/** Connects a new pilot; it starts docked at the capital with the starter ship. */
async function pilot(opts: { credits?: number; hull?: string } = {}): Promise<Player> {
  const bot = c.track(await Bot.connect(S.url, { name: `Trader${++pilots}` }));
  const p = S.world.players.get(bot.id)!;
  if (opts.hull) setShip(p, starterLoadout(opts.hull));
  if (opts.credits !== undefined) p.rec.credits = opts.credits;
  return p;
}

function setShip(p: Player, loadout: Loadout): void {
  p.rec.passport.ship.loadout = loadout;
  p.refit();
  p.ship!.state.hull = p.stats.hullMax;
  p.ship!.state.fuel = p.stats.fuelCap;
}

/** Test shortcut: moves a pilot's ship straight into the dock of a site, in any system. */
function dockAt(p: Player, pl: Place): void {
  const ship = p.ship!;
  if (p.sim!.def.id !== pl.system.id) {
    p.sim!.removeShip(ship);
    const sim = S.world.sim(pl.system.id);
    sim.addShip(ship);
    p.sim = sim;
    p.rec.system = pl.system.id;
  }
  ship.state.mode = FlightMode.Docked;
  ship.state.anchor = pl.site.id;
  ship.state.pos = [0, 0, 0];
  ship.state.vel = [0, 0, 0];
}

function places(service: StationService = 'market'): Place[] {
  const out: Place[] = [];
  for (const system of S.world.defs.values()) {
    for (const site of system.sites) if (site.services?.includes(service)) out.push({ system, site });
  }
  return out;
}

function view(p: Player): StationView {
  const v = S.world.stationView(p);
  if (!v) throw new Error('the pilot is not docked');
  return v;
}

const rowOf = (p: Player, id: string): MarketRow => {
  const r = view(p).market.find((x) => x.c === id);
  if (!r) throw new Error(`no market row for ${id}`);
  return r;
};

function setCargo(p: Player, items: { c: string; n: number; origin?: string }[]): void {
  const cargo = p.rec.passport.ship.cargo;
  cargo.length = 0;
  for (const it of items) cargo.push({ c: it.c, n: it.n, origin: it.origin ?? S.id });
}

const modulesValue = (lo: Loadout): number => lo.modules.reduce((sum, id) => sum + (id ? MODULES[id]!.price : 0), 0);
/** Catalog value of a ship: hull plus fitted modules. */
const shipValue = (lo: Loadout): number => HULLS[lo.hull]!.price + modulesValue(lo);
/** What the yard charges for a hull with its stock modules. */
const yardPrice = (hull: string): number => shipValue(starterLoadout(hull));
/** Trade-in for a ship that was paid for here: 80 % per item, rounded down. */
const tradeIn = (lo: Loadout): number =>
  Math.floor(HULLS[lo.hull]!.price * 0.8) + lo.modules.reduce((sum, id) => sum + (id ? Math.floor(MODULES[id]!.price * 0.8) : 0), 0);

beforeAll(async () => {
  S = await c.start({ name: 'Market', seed: 'market' });
  capital = S.world.capital();
});

afterAll(async () => {
  await c.stop();
});

describe('economy', () => {
  it('derives every market from its site economy and stores it', async () => {
    const p = await pilot();
    const all = places();
    expect(all.length).toBeGreaterThan(2);
    for (const pl of all) {
      dockAt(p, pl);
      const rows = view(p).market;
      baseline.set(keyOf(pl), rows);
      const byId = new Map(rows.map((r) => [r.c, r]));
      const eco = ECONOMIES[pl.site.economy ?? 'outpost'];
      for (const id of Object.keys(eco.produces)) {
        const r = byId.get(id)!;
        expect(r.buy, `${id} produced at ${pl.site.name}`).toBeLessThan(COMMODITIES[id]!.price);
        expect(r.demand).toBeLessThan(0);
      }
      for (const id of Object.keys(eco.consumes)) {
        const r = byId.get(id)!;
        expect(r.sell, `${id} consumed at ${pl.site.name}`).toBeGreaterThan(COMMODITIES[id]!.price);
        expect(r.demand).toBeGreaterThan(0);
      }
      for (const id of ['food', 'water', 'fuel_cells', 'medicine']) expect(byId.has(id)).toBe(true);
      for (const r of rows) {
        const base = COMMODITIES[r.c]!.price;
        // The spread: the station always sells for more than it pays.
        if (r.buy > 0) expect(r.buy).toBeGreaterThan(r.sell);
        expect(r.sell).toBeGreaterThanOrEqual(Math.floor(base * 0.35 * 0.94));
        expect(r.buy).toBeLessThanOrEqual(Math.ceil(base * 3 * 1.06));
        if (COMMODITIES[r.c]!.illegal) expect(pl.system.security).not.toBe('secure');
      }
      const doc = S.world.store.getDoc<{ t: number; stock: Record<string, number> }>('market', keyOf(pl))!;
      expect(Object.keys(doc.stock).sort()).toEqual(rows.map((r) => r.c).sort());
    }
    // Outposts trade smaller volumes than full stations.
    const total = (pl: Place): number => baseline.get(keyOf(pl))!.reduce((sum, r) => sum + r.stock, 0);
    const stations = all.filter((pl) => pl.site.kind === 'station').map(total);
    const outposts = all.filter((pl) => pl.site.kind === 'outpost').map(total);
    if (stations.length && outposts.length) expect(Math.max(...outposts)).toBeLessThan(Math.min(...stations));
  });

  it('has a profitable route between two station types', () => {
    let best = 0;
    for (const from of places()) {
      for (const to of places()) {
        if (from.site.economy === to.site.economy) continue;
        const made = ECONOMIES[from.site.economy ?? 'outpost'].produces;
        const used = ECONOMIES[to.site.economy ?? 'outpost'].consumes;
        for (const id of Object.keys(made)) {
          if (!Object.hasOwn(used, id)) continue;
          const buy = baseline.get(keyOf(from))!.find((r) => r.c === id)!.buy;
          const sell = baseline.get(keyOf(to))!.find((r) => r.c === id)!.sell;
          best = Math.max(best, sell / buy);
        }
      }
    }
    // Producer to consumer pays well above the spread.
    expect(best).toBeGreaterThan(1.5);
  });

  it('lets a new pilot make a first profitable trade from the capital', async () => {
    const p = await pilot();
    const start = p.rec.credits;
    expect(start).toBe(S.world.config.startCredits);
    expect(p.ship!.state.anchor).toBe(capital.site.id);
    expect(p.cargoFree()).toBe(16);
    const here = view(p).market.filter((r) => r.buy > 0);
    let best: { to: Place; c: string; n: number; gain: number } | null = null;
    for (const to of places()) {
      if (keyOf(to) === keyOf(capital)) continue;
      dockAt(p, to);
      for (const r of view(p).market) {
        const h = here.find((x) => x.c === r.c);
        if (!h) continue;
        const n = Math.min(16, h.stock, Math.floor(start / (h.buy * 1.15)));
        const gain = (r.sell - h.buy) * n;
        if (n > 0 && (!best || gain > best.gain)) best = { to, c: r.c, n, gain };
      }
    }
    expect(best).not.toBeNull();
    dockAt(p, capital);
    const bought = await cmd(p, { k: 'buy', c: best!.c, n: best!.n });
    expect(bought).toMatchObject({ ok: true });
    expect(p.rec.passport.ship.cargo).toEqual([{ c: best!.c, n: best!.n, origin: S.id }]);
    dockAt(p, best!.to);
    expect(await cmd(p, { k: 'sell', c: best!.c, n: best!.n })).toMatchObject({ ok: true });
    expect(p.rec.credits).toBeGreaterThan(start);
    expect(p.rec.passport.stats.tradeProfit).toBe(p.rec.credits - start);
    expect(p.rec.passport.ship.cargo).toEqual([]);
  });

  it('buying and selling at the same station always loses money', async () => {
    const p = await pilot({ credits: 200_000 });
    const rows = view(p).market.filter((r) => r.stock >= 6);
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) {
      for (const n of [1, 5]) {
        const before = p.rec.credits;
        expect(await cmd(p, { k: 'buy', c: r.c, n })).toMatchObject({ ok: true });
        expect(await cmd(p, { k: 'sell', c: r.c, n })).toMatchObject({ ok: true });
        expect(p.rec.credits, `${n} t of ${r.c}`).toBeLessThan(before);
      }
    }
  });

  it('refuses every service when not docked or when the station lacks it', async () => {
    const p = await pilot({ credits: 1_000_000 });
    p.ship!.state.fuel = 1;
    p.ship!.state.hull = 50;
    const all: Command[] = [
      { k: 'buy', c: 'food', n: 1 }, { k: 'sell', c: 'food', n: 1 }, { k: 'refuel' }, { k: 'repair' },
      { k: 'fit', slot: 7, module: 'cargo_1' }, { k: 'buyHull', hull: 'lancet' },
    ];
    setCargo(p, [{ c: 'food', n: 2 }]);
    p.ship!.state.mode = FlightMode.Normal;
    for (const command of all) expect(errOf(await cmd(p, command)), command.k).toMatch(/docked/);
    p.ship!.state.mode = FlightMode.Docked;

    const services = capital.site.services;
    capital.site.services = ['missions'];
    try {
      for (const command of all) expect(errOf(await cmd(p, command)), command.k).toMatch(/has no/);
      const v = view(p);
      expect([v.market, v.modules, v.hulls, v.fuelPrice, v.repairPrice]).toEqual([[], [], [], 0, 0]);
    } finally {
      capital.site.services = services;
    }
    expect(p.rec.credits).toBe(1_000_000);
    expect(cargoTonnes(p.rec.passport.ship.cargo)).toBe(2);
    expect(p.rec.passport.ship.loadout).toEqual(starterLoadout('wisp'));
  });

  it('refuses unknown ids and malformed amounts', async () => {
    const p = await pilot({ credits: 1_000_000 });
    setCargo(p, [{ c: 'food', n: 2 }]);
    for (const id of ['__proto__', 'constructor', 'toString', 'nope', '', 7, null, {}]) {
      expect(errOf(await cmd(p, { k: 'buy', c: id as never, n: 1 })), `buy ${String(id)}`).toMatch(/Unknown commodity/);
      expect(errOf(await cmd(p, { k: 'sell', c: id as never, n: 1 })), `sell ${String(id)}`).toMatch(/Unknown commodity/);
      expect(errOf(await cmd(p, { k: 'buyHull', hull: id as never })), `hull ${String(id)}`).toMatch(/Unknown hull/);
      if (id !== null) expect(errOf(await cmd(p, { k: 'fit', slot: 7, module: id as never })), `fit ${String(id)}`).toMatch(/Unknown module/);
    }
    for (const n of [0, -1, 1.5, NaN, Infinity, 1e15, '5', null]) {
      expect(errOf(await cmd(p, { k: 'buy', c: 'food', n: n as never })), `buy ${n}`).toMatch(/whole number/);
      expect(errOf(await cmd(p, { k: 'sell', c: 'food', n: n as never })), `sell ${n}`).toMatch(/whole number/);
    }
    for (const slot of [-1, 8, 1.5, NaN, '0', null]) {
      expect(errOf(await cmd(p, { k: 'fit', slot: slot as never, module: 'cargo_1' })), `slot ${slot}`).toMatch(/No such slot/);
    }
    expect(p.rec.credits).toBe(1_000_000);
    expect(p.rec.passport.ship.cargo).toEqual([{ c: 'food', n: 2, origin: S.id }]);
  });

  it('limits orders by stock, cargo space, credits and holdings', async () => {
    const p = await pilot({ credits: 1_000_000 });
    const rows = view(p).market;
    // Space: a row with more in stock than the 16 t hold takes.
    const deep = rows.find((r) => r.stock > 20)!;
    expect(errOf(await cmd(p, { k: 'buy', c: deep.c, n: 17 }))).toMatch(/cargo space/);
    // Stock: one tonne more than the station has, asked for by a ship that could carry it.
    const hauler = await pilot({ credits: 1_000_000, hull: 'drover' });
    const thin = rows.filter((r) => r.stock >= 1 && r.c !== deep.c).sort((a, b) => a.stock - b.stock)[0]!;
    expect(thin.stock).toBeLessThan(hauler.cargoFree());
    expect(errOf(await cmd(hauler, { k: 'buy', c: thin.c, n: thin.stock + 1 }))).toMatch(/in stock/);
    expect(await cmd(hauler, { k: 'buy', c: thin.c, n: thin.stock })).toMatchObject({ ok: true });
    expect(rowOf(hauler, thin.c)).toMatchObject({ stock: 0, buy: 0 });
    expect(errOf(await cmd(hauler, { k: 'buy', c: thin.c, n: 1 }))).toMatch(/Out of stock/);
    // Credits: exactly one credit short, then exactly enough.
    const cost = dataOf<{ total: number }>(await cmd(p, { k: 'buy', c: deep.c, n: 3 })).total;
    await cmd(p, { k: 'sell', c: deep.c, n: 3 });
    p.rec.credits = cost - 1;
    expect(errOf(await cmd(p, { k: 'buy', c: deep.c, n: 3 }))).toMatch(/credits/);
    expect(p.rec.credits).toBe(cost - 1);
    p.rec.credits = cost;
    expect(await cmd(p, { k: 'buy', c: deep.c, n: 3 })).toMatchObject({ ok: true, data: { n: 3, total: cost } });
    expect(p.rec.credits).toBe(0);
    // Holdings: more than is carried, and something not carried at all.
    expect(errOf(await cmd(p, { k: 'sell', c: deep.c, n: 4 }))).toMatch(/do not carry/);
    const other = rows.find((r) => r.c !== deep.c)!;
    expect(errOf(await cmd(p, { k: 'sell', c: other.c, n: 1 }))).toMatch(/do not carry/);
    expect(p.cargoCount(deep.c)).toBe(3);
  });

  it('charges a tariff by cargo origin and trust', async () => {
    const p = await pilot({ credits: 0, hull: 'drover' });
    const origin = { trusted: 'a'.repeat(16), neutral: 'b'.repeat(16), restricted: 'c'.repeat(16), blocked: 'd'.repeat(16) };
    const trust = S.world.config.trust;
    trust[origin.trusted] = 'trusted';
    trust[origin.neutral] = 'neutral';
    trust[origin.restricted] = 'restricted';
    trust[origin.blocked] = 'blocked';

    setCargo(p, [
      { c: 'food', n: 1 }, { c: 'food', n: 1, origin: origin.trusted }, { c: 'food', n: 1, origin: origin.neutral },
      { c: 'food', n: 1, origin: origin.restricted },
    ]);
    expect(view(p).tariffs).toEqual({ [origin.trusted]: 0, [origin.neutral]: S.world.config.tariff, [origin.restricted]: 0.9 });

    /** Sells 4 t of an expensive good from one origin and returns the share withheld. */
    const rate = async (from: string): Promise<number> => {
      setCargo(p, [{ c: 'reactor_parts', n: 4, origin: from }]);
      const before = p.rec.credits;
      const r = dataOf<{ total: number; tariff: number }>(await cmd(p, { k: 'sell', c: 'reactor_parts', n: 4 }));
      expect(p.rec.credits - before).toBe(r.total);
      return r.tariff / (r.total + r.tariff);
    };
    expect(await rate(S.id)).toBe(0);
    expect(await rate(origin.trusted)).toBe(0);
    expect(await rate(origin.neutral)).toBeCloseTo(S.world.config.tariff, 2);
    expect(await rate(origin.restricted)).toBeCloseTo(0.9, 2);
    expect(await rate(origin.blocked)).toBeCloseTo(0.9, 2);
    expect(await rate('__proto__')).toBeCloseTo(0.9, 2);
    // A mixed order taxes each stack by its own origin.
    setCargo(p, [{ c: 'reactor_parts', n: 3 }, { c: 'reactor_parts', n: 3, origin: origin.restricted }]);
    const mixed = dataOf<{ total: number; tariff: number }>(await cmd(p, { k: 'sell', c: 'reactor_parts', n: 6 }));
    expect(mixed.tariff / (mixed.total + mixed.tariff)).toBeGreaterThan(0.35);
    expect(mixed.tariff / (mixed.total + mixed.tariff)).toBeLessThan(0.55);
    expect(Number.isSafeInteger(p.rec.credits)).toBe(true);
    expect(p.rec.passport.stats.tradeProfit).toBe(p.rec.credits);
  });

  it('does not buy contraband in secure space', async () => {
    const p = await pilot();
    const secure = places().find((pl) => pl.system.security === 'secure')!;
    expect(secure).toBeDefined();
    dockAt(p, secure);
    setCargo(p, [{ c: 'stims', n: 2 }]);
    expect(view(p).market.some((r) => r.c === 'stims')).toBe(false);
    expect(errOf(await cmd(p, { k: 'sell', c: 'stims', n: 1 }))).toMatch(/contraband/);
    expect(errOf(await cmd(p, { k: 'buy', c: 'stims', n: 1 }))).toMatch(/does not trade/);
    const free = places().find((pl) => pl.system.security !== 'secure');
    if (free) {
      dockAt(p, free);
      expect(await cmd(p, { k: 'sell', c: 'stims', n: 1 })).toMatchObject({ ok: true });
    }
    expect(p.cargoCount('stims')).toBe(free ? 1 : 2);
  });

  it('refuels and repairs, partially when credits run short', async () => {
    const p = await pilot();
    const ship = p.ship!;
    ship.state.fuel = 2;
    ship.state.hull = ship.stats.hullMax - 50;
    const v = view(p);
    expect(v.fuelPrice).toBeGreaterThan(0);
    const repairCost = Math.ceil(50 * (2 + HULLS.wisp!.price / 50_000));
    expect(v.repairPrice).toBe(repairCost);
    const start = p.rec.credits;
    expect(await cmd(p, { k: 'refuel' })).toMatchObject({ ok: true });
    expect(ship.state.fuel).toBe(ship.stats.fuelCap);
    expect(p.rec.credits).toBe(start - Math.ceil((ship.stats.fuelCap - 2) * v.fuelPrice));
    expect(errOf(await cmd(p, { k: 'refuel' }))).toMatch(/full/);
    const mid = p.rec.credits;
    expect(await cmd(p, { k: 'repair' })).toMatchObject({ ok: true });
    expect(ship.state.hull).toBe(ship.stats.hullMax);
    expect(p.rec.credits).toBe(mid - repairCost);
    expect(view(p).repairPrice).toBe(0);
    expect(errOf(await cmd(p, { k: 'repair' }))).toMatch(/undamaged/);

    p.rec.credits = 30;
    ship.state.fuel = 0;
    expect(await cmd(p, { k: 'refuel' })).toMatchObject({ ok: true });
    expect(p.rec.credits).toBe(0);
    expect(ship.state.fuel).toBeCloseTo(30 / v.fuelPrice, 6);
    expect(errOf(await cmd(p, { k: 'refuel' }))).toMatch(/credits/);
    p.rec.credits = 20;
    ship.state.hull = ship.stats.hullMax - 100;
    expect(await cmd(p, { k: 'repair' })).toMatchObject({ ok: true });
    expect(p.rec.credits).toBe(0);
    expect(ship.state.hull).toBeCloseTo(ship.stats.hullMax - 100 + 20 / (2 + HULLS.wisp!.price / 50_000), 6);
    expect(errOf(await cmd(p, { k: 'repair' }))).toMatch(/credits/);
  });

  it('fits modules by slot type, price and cargo capacity', async () => {
    const p = await pilot({ credits: 200_000 });
    // Wisp: weapon, weapon, shield, thruster, fold, reactor, utility, utility.
    const sold = view(p).modules;
    expect(sold).toEqual(expect.arrayContaining(['pulse_1', 'cargo_1', 'shield_2']));
    expect(sold.includes('shield_3')).toBe(['hightech', 'military'].includes(capital.site.economy!));
    expect(errOf(await cmd(p, { k: 'fit', slot: 0, module: 'shield_1' }))).toMatch(/does not fit/);
    expect(errOf(await cmd(p, { k: 'fit', slot: 2, module: null }))).toMatch(/cannot be left empty/);
    expect(errOf(await cmd(p, { k: 'fit', slot: 7, module: null }))).toMatch(/already empty/);
    expect(errOf(await cmd(p, { k: 'fit', slot: 0, module: 'pulse_1' }))).toMatch(/already fitted/);
    expect(p.rec.credits).toBe(200_000);

    // A mandatory slot can be swapped: pay the new module, get 80 % of the old one back.
    expect(await cmd(p, { k: 'fit', slot: 2, module: 'shield_2' })).toMatchObject({ ok: true, data: { cost: 48_000, refund: 4_800 } });
    expect(p.rec.credits).toBe(200_000 - 48_000 + 4_800);
    expect(p.rec.passport.ship.loadout.modules[2]).toBe('shield_2');
    expect(p.stats.shieldMax).toBe(HULLS.wisp!.shield + 160);
    expect(p.ship!.stats).toBe(p.stats);
    expect(p.ship!.loadout).toBe(p.rec.passport.ship.loadout);
    // Weapon and utility slots can be emptied.
    expect(await cmd(p, { k: 'fit', slot: 0, module: null })).toMatchObject({ ok: true, data: { cost: 0, refund: 3_200 } });
    expect(p.stats.weapons.length).toBe(1);
    expect(await cmd(p, { k: 'fit', slot: 7, module: 'cargo_1' })).toMatchObject({ ok: true });
    expect(p.rec.credits).toBe(200_000 - 48_000 + 4_800 + 3_200 - 3_000);
    expect(p.cargoFree()).toBe(24);

    // The hold may not shrink below what is carried.
    setCargo(p, [{ c: 'food', n: 20 }]);
    expect(errOf(await cmd(p, { k: 'fit', slot: 7, module: null }))).toMatch(/cargo/);
    expect(errOf(await cmd(p, { k: 'fit', slot: 6, module: 'tank_1' }))).toMatch(/cargo/);
    setCargo(p, []);
    p.rec.credits = 3_999;
    expect(errOf(await cmd(p, { k: 'fit', slot: 0, module: 'pulse_1' }))).toMatch(/credits/);
    expect(p.rec.credits).toBe(3_999);

    // Higher tiers depend on the station economy.
    const economy = capital.site.economy;
    capital.site.economy = 'agri';
    try {
      p.rec.credits = 500_000;
      expect(view(p).modules.every((id) => MODULES[id]!.tier === 1)).toBe(true);
      expect(errOf(await cmd(p, { k: 'fit', slot: 3, module: 'thruster_2' }))).toMatch(/not sold here/);
    } finally {
      capital.site.economy = economy;
    }
  });

  it('trades in the old ship for a new hull with its stock loadout', async () => {
    const p = await pilot({ credits: 500_000 });
    expect(view(p).hulls).toEqual(Object.keys(HULLS));
    expect(errOf(await cmd(p, { k: 'buyHull', hull: 'wisp' }))).toMatch(/already fly/);
    setCargo(p, [{ c: 'food', n: 10 }]);
    expect(errOf(await cmd(p, { k: 'buyHull', hull: 'lancet' }))).toMatch(/cargo/);
    setCargo(p, [{ c: 'food', n: 4 }]);
    p.ship!.state.hull = 40;
    p.ship!.state.fuel = 1;
    const refund = tradeIn(starterLoadout('wisp'));
    expect(refund).toBe(44_000);
    expect(await cmd(p, { k: 'buyHull', hull: 'lancet' })).toMatchObject({ ok: true, data: { cost: yardPrice('lancet'), tradeIn: refund } });
    expect(p.rec.credits).toBe(500_000 - yardPrice('lancet') + refund);
    expect(p.rec.passport.ship.loadout).toEqual(starterLoadout('lancet'));
    expect(p.ship!.stats.hull).toBe('lancet');
    expect(p.ship!.state.hull).toBe(HULLS.lancet!.hull);
    expect(p.ship!.state.fuel).toBe(HULLS.lancet!.fuel);
    expect(p.cargoCount('food')).toBe(4);
    // Not enough credits even with the trade-in.
    p.rec.credits = 1_000;
    expect(errOf(await cmd(p, { k: 'buyHull', hull: 'bulwark' }))).toMatch(/credits/);
    expect(p.rec.credits).toBe(1_000);
    expect(p.rec.passport.ship.loadout.hull).toBe('lancet');
  });

  it('sells only some hulls at a small yard', async () => {
    const p = await pilot({ credits: 5_000_000 });
    const small = places().find((pl) => keyOf(pl) !== keyOf(capital))!;
    dockAt(p, small);
    // Load the market first so the temporary change below does not shape it.
    view(p);
    const saved = { kind: small.site.kind, services: small.site.services };
    small.site.kind = 'outpost';
    small.site.services = [...(saved.services ?? []), 'shipyard'];
    try {
      const hulls = view(p).hulls;
      expect(hulls).toContain('wisp');
      expect(hulls.length).toBeGreaterThanOrEqual(2);
      expect(hulls.length).toBeLessThan(Object.keys(HULLS).length);
      const missing = Object.keys(HULLS).find((id) => !hulls.includes(id))!;
      expect(errOf(await cmd(p, { k: 'buyHull', hull: missing }))).toMatch(/not sold here/);
      const offered = hulls.find((id) => id !== 'wisp')!;
      expect(await cmd(p, { k: 'buyHull', hull: offered })).toMatchObject({ ok: true });
    } finally {
      small.site.kind = saved.kind;
      small.site.services = saved.services;
    }
  });

  it('pays nothing for a hull and modules that arrived from a server that is not trusted', async () => {
    const p = await pilot({ hull: 'bulwark', credits: 0 });
    const arrive = (trust: string, extra: object = {}): void => {
      setShip(p, starterLoadout('bulwark'));
      p.rec.data.customs = { issuer: 'e'.repeat(16), trust, at: c.nowMs, loadout: structuredClone(p.rec.passport.ship.loadout), ...extra };
    };
    arrive('neutral');
    // The Bulwark is worth nothing as a trade-in: the full yard price is due.
    p.rec.credits = yardPrice('wisp') - 1;
    expect(errOf(await cmd(p, { k: 'buyHull', hull: 'wisp' }))).toMatch(/credits/);
    // Replacing an arrived module refunds nothing ...
    p.rec.credits = MODULES.pulse_1!.price;
    expect(await cmd(p, { k: 'fit', slot: 0, module: 'pulse_1' })).toMatchObject({ ok: true, data: { refund: 0 } });
    expect(p.rec.credits).toBe(0);
    // ... but the module bought here is refunded like any other.
    p.rec.credits = MODULES.cannon_1!.price - 3_200;
    expect(await cmd(p, { k: 'fit', slot: 0, module: 'cannon_1' })).toMatchObject({ ok: true, data: { refund: 3_200 } });
    expect(p.rec.credits).toBe(0);
    // Emptying an arrived slot pays nothing either.
    expect(await cmd(p, { k: 'fit', slot: 4, module: null })).toMatchObject({ ok: true, data: { refund: 0 } });
    expect(p.rec.credits).toBe(0);
    // In the trade-in only the module bought here counts.
    p.rec.credits = yardPrice('wisp') - Math.floor(MODULES.cannon_1!.price * 0.8);
    expect(await cmd(p, { k: 'buyHull', hull: 'wisp' })).toMatchObject({ ok: true, data: { tradeIn: 7_600 } });
    expect(p.rec.credits).toBe(0);
    // The Wisp was bought here, so it trades in at 80 %.
    p.rec.credits = yardPrice('lancet') - tradeIn(starterLoadout('wisp'));
    expect(await cmd(p, { k: 'buyHull', hull: 'lancet' })).toMatchObject({ ok: true });
    expect(p.rec.credits).toBe(0);

    // A record with a damaged or missing loadout copy does not open a loophole.
    for (const loadout of [{ hull: 'wisp', modules: [] }, undefined, null]) {
      arrive('restricted', { loadout });
      p.rec.credits = yardPrice('wisp') - 1;
      expect(errOf(await cmd(p, { k: 'buyHull', hull: 'wisp' }))).toMatch(/credits/);
      p.rec.credits = 0;
      expect(await cmd(p, { k: 'fit', slot: 0, module: null })).toMatchObject({ ok: true, data: { refund: 0 } });
    }
    // A trusted issuer is believed: its ships trade in at the usual rate.
    arrive('trusted');
    p.rec.credits = 0;
    expect(await cmd(p, { k: 'buyHull', hull: 'wisp' })).toMatchObject({ ok: true });
    expect(p.rec.credits).toBe(tradeIn(starterLoadout('bulwark')) - yardPrice('wisp'));
  });

  it('never creates value in 300 random buy, sell, fit and buyHull commands', async () => {
    const p = await pilot({ credits: 20_000_000 });
    const rng = new Rng('economy-walk');
    const commodities = [...view(p).market.map((r) => r.c), 'stims', '__proto__'];
    const modules = [...Object.keys(MODULES), '__proto__'];
    const hulls = [...Object.keys(HULLS), 'constructor'];
    const worth = (): number => p.rec.credits + shipValue(p.rec.passport.ship.loadout);
    const start = worth();
    const done: Record<string, number> = { buy: 0, sell: 0, fit: 0, buyHull: 0 };
    for (let i = 0; i < 300; i++) {
      const roll = rng.float();
      const cargo = p.rec.passport.ship.cargo;
      let command: Command;
      if (roll < 0.4) {
        command = { k: 'buy', c: rng.pick(commodities), n: rng.int(1, 30) };
      } else if (roll < 0.72) {
        const held = cargo.length && rng.chance(0.8) ? rng.pick(cargo) : null;
        command = { k: 'sell', c: held ? held.c : rng.pick(commodities), n: rng.int(1, (held?.n ?? 3) + 2) };
      } else if (roll < 0.92) {
        const slots = HULLS[p.rec.passport.ship.loadout.hull]!.slots;
        const slot = rng.int(-1, slots.length);
        const fitting = modules.filter((id) => MODULES[id]?.slot === slots[slot]);
        const module = rng.chance(0.2) ? null : fitting.length && rng.chance(0.7) ? rng.pick(fitting) : rng.pick(modules);
        command = { k: 'fit', slot, module };
      } else {
        command = { k: 'buyHull', hull: rng.pick(hulls) };
      }
      const r = await cmd(p, command);
      if (r.ok) done[command.k]!++;
      else expect(r.err, `${JSON.stringify(command)}`).not.toMatch(/internal/);
      const credits = p.rec.credits;
      expect(Number.isSafeInteger(credits) && credits >= 0, `credits ${credits} after ${JSON.stringify(command)}`).toBe(true);
      // Cargo counts as nothing here: all of it was bought at this station for more than it sells for.
      expect(worth(), `step ${i}: ${JSON.stringify(command)}`).toBeLessThanOrEqual(start);
      expect(cargoTonnes(p.rec.passport.ship.cargo)).toBeLessThanOrEqual(Math.floor(p.stats.cargoCap));
    }
    for (const k of Object.keys(done)) expect(done[k], `${k} succeeded at least once`).toBeGreaterThan(0);
    // Turning the whole hold back into credits still leaves less than there was.
    for (const item of [...p.rec.passport.ship.cargo]) expect(await cmd(p, { k: 'sell', c: item.c, n: item.n })).toMatchObject({ ok: true });
    expect(p.rec.passport.ship.cargo).toEqual([]);
    expect(worth()).toBeLessThan(start);
  });

  it('moves prices with trades and lets them recover over time', async () => {
    const p = await pilot({ credits: 5_000_000, hull: 'drover' });
    // Bring the market back to rest after the other tests, then pick its deepest row.
    c.nowMs += 5 * 86_400_000;
    const key = keyOf(capital);
    const rest = view(p).market.reduce((a, b) => (b.stock > a.stock ? b : a));
    const id = rest.c;
    const base = baseline.get(key)!.find((r) => r.c === id)!;
    expect(Math.abs(rest.buy - base.buy)).toBeLessThanOrEqual(1);
    const n = Math.min(40, Math.floor(rest.stock / 3));
    expect(n).toBeGreaterThan(5);

    const first = dataOf<{ total: number }>(await cmd(p, { k: 'buy', c: id, n })).total;
    const after = rowOf(p, id);
    expect(after.stock).toBe(rest.stock - n);
    expect(after.buy).toBeGreaterThan(rest.buy);
    expect(after.sell).toBeGreaterThan(rest.sell);
    expect(after.demand).toBeGreaterThan(rest.demand);
    // The same order again costs more: the price is integrated over the order.
    const second = dataOf<{ total: number }>(await cmd(p, { k: 'buy', c: id, n })).total;
    expect(second).toBeGreaterThan(first);
    expect(first).toBeGreaterThan(rest.buy * n);
    const low = rowOf(p, id);
    // Selling pushes the price back down.
    await cmd(p, { k: 'sell', c: id, n: 3 });
    expect(rowOf(p, id).sell).toBeLessThanOrEqual(low.sell);
    await cmd(p, { k: 'buy', c: id, n: 3 });

    // Two hours later the world tick has moved the stored stock part of the way back.
    const doc = (): { t: number; stock: Record<string, number> } => S.world.store.getDoc('market', key)!;
    const stored = doc();
    expect(stored.stock[id]).toBeLessThan(low.stock + 1);
    c.nowMs += 2 * 3_600_000;
    await c.run(150);
    const later = doc();
    expect(later.t).toBeGreaterThan(stored.t);
    expect(later.stock[id]).toBeGreaterThan(stored.stock[id]! + 1);
    expect(later.stock[id]).toBeLessThan(rest.stock - 1);
    // After days it is back where it started; the catch-up is capped, so a long gap changes nothing more.
    c.nowMs += 30 * 86_400_000;
    const back = rowOf(p, id);
    expect(Math.abs(back.buy - rest.buy)).toBeLessThanOrEqual(1);
    expect(back.stock).toBeGreaterThanOrEqual(rest.stock - 1);
    expect(back.stock).toBeLessThanOrEqual(rest.stock + 1);
  });
});
