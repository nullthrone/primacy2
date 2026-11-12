/**
 * The trade model under attack: four real servers and pilots who carry cargo and ships between
 * them. One server (Home) is the one under test; it has an honest partner, a customs union
 * member, and a cheat that edits its own database and that Home only knows as a visitor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Button,
  COMMODITIES,
  DT,
  EntityKind,
  FlightMode,
  HULLS,
  MODULES,
  PEER_TIMEOUT_MS,
  PROTOCOL_VERSION,
  cargoTonnes,
  computeShipStats,
  idFromPublicKey,
  newShipState,
  rulesFingerprint,
  starterLoadout,
  type CargoItem,
} from '@primacy2/shared';
import { Store, isHullBound, isSlotBound, makeConfig, newShip, type CommandResult, type Player, type PrimacyServer } from '@primacy2/server';
import { wreckData } from '../packages/server/src/modules/salvage.ts';
import { Bot } from './bot.ts';
import { Cluster, testKeys } from './harness.ts';

const c = new Cluster();
const idOf = (name: string): string => idFromPublicKey(testKeys(name).publicKey);
/** Ids are known before the servers start, so every rating is part of the first descriptor. */
const ID = { H: idOf('THome'), P: idOf('TPartner'), U: idOf('TUnion'), C: idOf('TCheat') };
let H: PrimacyServer;
let P: PrimacyServer;
let U: PrimacyServer;
let C: PrimacyServer;

/** A staple every market trades. */
const GOOD = 'medicine';
const PRICE = COMMODITIES[GOOD]!.price;
const lot = (n: number, origin: string, sealed = false): CargoItem => (sealed ? { c: GOOD, n, origin, sealed: true } : { c: GOOD, n, origin });

const playerOf = (s: PrimacyServer, bot: Bot): Player => s.world.players.get(bot.id)!;
const hold = (s: PrimacyServer, bot: Bot): CargoItem[] => playerOf(s, bot).rec.passport.ship.cargo;
const byOrigin = (lots: CargoItem[]): CargoItem[] => [...lots].sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0));
const sell = (s: PrimacyServer, p: Player, n: number, good = GOOD): Promise<CommandResult> => s.world.handleCommand(p, { k: 'sell', c: good, n });
const exportsTo = (peer: string): number => H.world.trade.ledger(peer).exports;

/** A new pilot at home on `s`, docked at the capital in a ship bought there. */
async function newPilot(s: PrimacyServer, name: string, hull = 'drover'): Promise<Bot> {
  const bot = c.track(await Bot.connect(s.url, { name }));
  await c.run(2);
  const p = playerOf(s, bot);
  p.rec.passport.ship.loadout = starterLoadout(hull);
  p.refit();
  p.ship!.state.hull = p.stats.hullMax;
  p.ship!.state.fuel = p.stats.fuelCap;
  return bot;
}

/** What a server operator can do to its own database: put any cargo with any label into a hold. */
function load(s: PrimacyServer, bot: Bot, lots: CargoItem[]): void {
  const cargo = hold(s, bot);
  cargo.length = 0;
  cargo.push(...lots.map((x) => ({ ...x })));
}

async function depart(bot: Bot, from: PrimacyServer, to: PrimacyServer): Promise<void> {
  const res = from.world.handoff(playerOf(from, bot), from.fed.known.get(to.id)!, { kind: 'fold', system: `${to.id}:0` });
  expect(res).toEqual({ ok: true });
  await c.settle(() => bot.handoff !== null, 'handoff message');
  c.bots.delete(bot);
  bot.close();
}

/** Hands the pilot over from one server to another and returns the connection to the destination. */
async function travel(bot: Bot, from: PrimacyServer, to: PrimacyServer): Promise<Bot> {
  await depart(bot, from, to);
  const next = c.track(await Bot.connect(to.url, { keys: bot.keys, name: bot.name, ticket: bot.handoff!.ticket }));
  await c.run(2);
  return next;
}

async function refused(url: string, opts: Parameters<typeof Bot.connect>[1]): Promise<Bot> {
  try {
    const b = await Bot.connect(url, opts);
    b.close();
    throw new Error('connection was accepted');
  } catch (err) {
    const b = (err as { bot?: Bot }).bot;
    if (!b) throw err;
    return b;
  }
}

/** Test shortcut: puts the pilot's ship into the dock of the capital station of the system it arrived in. */
function dock(s: PrimacyServer, bot: Bot): Player {
  const p = playerOf(s, bot);
  const st = p.ship!.state;
  st.mode = FlightMode.Docked;
  st.anchor = s.world.capital().site.id;
  st.pos = [0, 0, 0];
  st.vel = [0, 0, 0];
  st.cruiseSpeed = 0;
  return p;
}

beforeAll(async () => {
  // Every pilot of this file connects from the same address.
  const base = { maxConnectionsPerIp: 500 };
  H = await c.start({ ...base, name: 'THome', seed: 'thome', trust: { [ID.P]: 'partner', [ID.U]: 'union' }, tradeCredits: { [ID.P]: 1_000_000 } });
  P = await c.start({ ...base, name: 'TPartner', seed: 'tpartner', peers: [H.url], trust: { [ID.H]: 'partner', [ID.C]: 'partner' } });
  U = await c.start({ ...base, name: 'TUnion', seed: 'tunion', peers: [H.url], trust: { [ID.H]: 'union' } });
  // The cheat calls everybody partner; what matters is how the others rate it: Home and Union not at all (visitor).
  C = await c.start({ ...base, name: 'TCheat', seed: 'tcheat', peers: [H.url, P.url, U.url], defaultTrust: 'partner' });
  await P.peer();
  await U.peer();
  await C.peer();
  // Wandering NPCs would get in the way of the ships parked in space.
  for (const s of [H, P, U, C]) s.world.modules.splice(s.world.modules.findIndex((m) => m.name === 'npc'), 1);
});

afterAll(async () => {
  await c.stop();
});

describe('trade model: configuration and books', () => {
  it('has the documented defaults and validates the new keys', () => {
    expect(makeConfig()).toMatchObject({
      defaultTrust: 'visitor', tradeCredit: 50_000, tradeCredits: {}, gateTradeCredit: 250_000, importLicenceRate: 1,
      shipLimit: { partner: null, visitor: 'drover' },
    });
    expect(() => makeConfig({ defaultTrust: 'neutral' as never })).toThrow(/"neutral" is now called "partner"/);
    expect(() => makeConfig({ trust: { [ID.P]: 'trusted' as never } })).toThrow(/is now called "union"/);
    expect(() => makeConfig({ trust: { [ID.P]: 'friend' as never } })).toThrow(/must be union, partner, visitor or blocked/);
    expect(() => makeConfig({ defaultTrust: 'union' })).toThrow(/defaultTrust cannot be union/);
    expect(() => makeConfig({ tradeCredit: -1 })).toThrow(/tradeCredit/);
    expect(() => makeConfig({ tradeCredits: { nobody: 5 } })).toThrow(/not a server id/);
    expect(() => makeConfig({ tradeCredits: { [ID.P]: Number.NaN } })).toThrow(/tradeCredits/);
    expect(() => makeConfig({ gateTradeCredit: -5 })).toThrow(/gateTradeCredit/);
    expect(() => makeConfig({ importLicenceRate: -1 })).toThrow(/importLicenceRate/);
    expect(() => makeConfig({ shipLimit: { partner: 'made_up', visitor: null } })).toThrow(/shipLimit\.partner/);
    expect(makeConfig({ shipLimit: { partner: 'wayfarer', visitor: null } }).shipLimit).toEqual({ partner: 'wayfarer', visitor: null });
  });

  it('the descriptor publishes the fingerprint, the ratings and the class limits', () => {
    const d = H.descriptor().body;
    expect(d.proto).toBe(PROTOCOL_VERSION);
    expect(d.rules.defaultTrust).toBe('visitor');
    expect(d.trade).toEqual({
      fingerprint: rulesFingerprint(), union: [ID.U], partner: [ID.P], shipLimit: { partner: null, visitor: HULLS.drover!.price },
    });
  });

  it('the credit line is the default or the per-server entry, plus a bonus only while an active gate links the two', () => {
    const book = H.world.trade;
    expect(book.creditLine(ID.C)).toBe(50_000);
    expect(book.creditLine(ID.P)).toBe(1_000_000);
    const site = H.world.capital().site;
    const saved = site.gate;
    const gate = (peer: string, state: 'planned' | 'building' | 'active' | 'dormant') => ({
      linkId: 'test-link', peer, remoteSystem: `${peer}:0`, state, progress: 1, remoteProgress: 1,
    });
    try {
      for (const state of ['planned', 'building', 'dormant'] as const) {
        site.gate = gate(ID.P, state);
        expect(book.creditLine(ID.P)).toBe(1_000_000);
      }
      site.gate = gate(ID.P, 'active');
      expect(book.creditLine(ID.P)).toBe(1_000_000 + H.config.gateTradeCredit);
      // The gate leads to the partner; nobody else gains from it.
      expect(book.creditLine(ID.C)).toBe(50_000);
      const l = book.ledger(ID.P);
      expect(book.allowance(ID.P)).toBe(l.exports + 1_000_000 + 250_000 - l.imports);
    } finally {
      if (saved) site.gate = saved;
      else delete site.gate;
    }
    expect(book.creditLine(ID.P)).toBe(1_000_000);
  });

  it('the ledger is kept in the store', () => {
    const store = new Store(':memory:');
    expect(store.loadLedger(ID.P)).toEqual({ exports: 0, imports: 0 });
    store.saveLedger(ID.P, { exports: 720, imports: 360 });
    expect(store.loadLedger(ID.P)).toEqual({ exports: 720, imports: 360 });
    store.close();
  });

  it('the absorb check books imports and licence use once; an all-or-nothing take that fails books nothing', async () => {
    let bot = await newPilot(P, 'Bookkeeper');
    load(P, bot, [lot(6, ID.P)]);
    bot = await travel(bot, P, H);
    const p = dock(H, bot);
    const book = H.world.trade;
    book.creditIncome(p, 4 * PRICE, 'bounty');
    const imports = book.ledger(ID.P).imports;
    // A preview writes nothing.
    expect(book.absorb(p, [lot(2, ID.P)], { book: false })).toMatchObject({ n: 2, limit: null, lots: [{ status: 'import', take: 2, limit: null }] });
    expect(book.ledger(ID.P).imports).toBe(imports);
    expect(book.licence(p)).toEqual({ cap: 4 * PRICE, used: 0 });
    // Not enough licence for five tonnes: nothing is taken, nothing is booked.
    expect(book.takeCargo(p, GOOD, 5, { exact: true })).toEqual({ lots: [], n: 0, limit: 'licence', limitOrigin: ID.P });
    expect(hold(H, bot)).toEqual([lot(6, ID.P)]);
    expect(book.ledger(ID.P).imports).toBe(imports);
    expect(book.licence(p)).toEqual({ cap: 4 * PRICE, used: 0 });
    // Three tonnes pass in full and are booked once: in the ledger, in the store and on the licence.
    expect(book.takeCargo(p, GOOD, 3, { exact: true })).toEqual({ lots: [lot(3, ID.P)], n: 3, limit: null, limitOrigin: null });
    expect(hold(H, bot)).toEqual([lot(3, ID.P)]);
    expect(book.ledger(ID.P).imports).toBe(imports + 3 * PRICE);
    expect(H.store.loadLedger(ID.P)).toEqual(book.ledger(ID.P));
    expect(book.licence(p)).toEqual({ cap: 4 * PRICE, used: 3 * PRICE });
    // Lots handed to the check directly: local goods pass, the import up to the licence, sealed never.
    const res = book.absorb(p, [lot(2, ID.H), lot(2, ID.P), lot(1, ID.C)]);
    expect(res.lots.map((l) => [l.status, l.take, l.limit])).toEqual([['local', 2, null], ['import', 1, 'licence'], ['sealed', 0, 'sealed']]);
    expect(res).toMatchObject({ n: 3, limit: 'licence', limitOrigin: ID.P });
    expect(book.ledger(ID.P).imports).toBe(imports + 4 * PRICE);
    expect(book.licence(p)).toEqual({ cap: 4 * PRICE, used: 4 * PRICE });
    // More than is on board.
    expect(book.takeCargo(p, 'food', 1)).toMatchObject({ n: 0, limit: 'missing' });
  });
});

describe('trade model: cargo', () => {
  it("a partner labels minted cargo with a third server's id: it arrives sealed", async () => {
    let bot = await newPilot(P, 'Mislabel');
    const stranger = 'f'.repeat(16);
    // A union member's label would make the goods free at Home if the partner were believed.
    load(P, bot, [lot(3, ID.U), lot(3, stranger), lot(2, ID.P)]);
    bot = await travel(bot, P, H);
    expect(hold(H, bot)).toEqual([lot(3, ID.U, true), lot(3, stranger, true), lot(2, ID.P)]);
    const p = dock(H, bot);
    H.world.trade.creditIncome(p, 1_000_000, 'mission');
    expect(await sell(H, p, 8)).toMatchObject({ ok: true, data: { n: 2, limit: 'sealed' } });
    expect(hold(H, bot)).toEqual([lot(3, ID.U, true), lot(3, stranger, true)]);
    expect(H.world.stationView(p)!.imports).toEqual([
      { origin: ID.U, name: 'TUnion', tier: 'union', allowance: null, tonnes: 3, sealed: 3 },
      { origin: stranger, name: stranger.slice(0, 6), tier: 'visitor', allowance: 0, tonnes: 3, sealed: 3 },
    ]);
  });

  it("a visitor's cargo cannot be sold, taken for a delivery, or sold after being jettisoned and scooped", async () => {
    let bot = await newPilot(C, 'Smuggler');
    // The cheat labels part of its goods with Home's own id, the most valuable label there is.
    load(C, bot, [lot(6, ID.H), lot(4, ID.C)]);
    bot = await travel(bot, C, H);
    expect(hold(H, bot)).toEqual([lot(6, ID.H, true), lot(4, ID.C, true)]);
    const p = dock(H, bot);
    H.world.trade.creditIncome(p, 1_000_000, 'mission');
    const credits = p.rec.credits;
    expect(await sell(H, p, 10)).toMatchObject({ ok: false, err: expect.stringMatching(/sealed/) });
    // What a delivery or a gate donation would do: take the cargo, all of it or as much as passes.
    expect(H.world.trade.takeCargo(p, GOOD, 6, { exact: true })).toMatchObject({ n: 0, lots: [], limit: 'sealed' });
    expect(H.world.trade.takeCargo(p, GOOD, 6)).toMatchObject({ n: 0, lots: [], limit: 'sealed' });
    expect(H.world.trade.absorb(p, hold(H, bot))).toMatchObject({ n: 0, limit: 'sealed' });
    expect(cargoTonnes(hold(H, bot))).toBe(10);

    // Out of the airlock and back in: the seal stays on the goods.
    expect(await H.world.handleCommand(p, { k: 'undock' })).toMatchObject({ ok: true });
    expect(await H.world.handleCommand(p, { k: 'jettison', c: GOOD, n: 10 })).toMatchObject({ ok: true, data: { n: 10 } });
    expect(hold(H, bot)).toEqual([]);
    await c.until(() => cargoTonnes(hold(H, bot)) === 10, 'scooping the canister back', 900);
    expect(byOrigin(hold(H, bot))).toEqual(byOrigin([lot(6, ID.H, true), lot(4, ID.C, true)]));
    dock(H, bot);
    expect(await sell(H, p, 10)).toMatchObject({ ok: false, err: expect.stringMatching(/sealed/) });
    expect(p.rec.credits).toBe(credits);
    expect(H.world.trade.ledger(ID.C).imports).toBe(0);
  });

  it.todo('a sealed shipment cannot complete a delivery or mining mission (needs missionComplete wired to takeCargo)');

  it('sealed cargo stays sealed in the wreck of the ship, in the pods cut from it, and is gone after respawn', async () => {
    let bot = await newPilot(C, 'Wrecked');
    load(C, bot, [lot(5, ID.H)]);
    bot = await travel(bot, C, H);
    const p = dock(H, bot);
    expect(await H.world.handleCommand(p, { k: 'undock' })).toMatchObject({ ok: true });
    const sim = p.sim!;
    const ship = p.ship!;
    sim.destroy(ship, null);
    const wreck = [...sim.objects.values()].find((o) => o.kind === EntityKind.Wreck)!;
    expect(wreckData(wreck)!.contents.filter((it) => it.c === GOOD)).toEqual([lot(5, ID.H, true)]);

    // A salvager with a mining laser cuts the wreck open.
    const loadout = starterLoadout('delver');
    const stats = computeShipStats(loadout);
    const state = newShipState(stats);
    state.anchor = wreck.anchor;
    state.pos = [wreck.pos[0], wreck.pos[1], wreck.pos[2] + 300];
    const salvager = newShip(H.world.allocId(), 'Salvager', loadout, stats, state);
    sim.addShip(salvager);
    salvager.input.buttons = Button.Fire3;
    for (let i = 0; i < 20_000 && sim.objects.has(wreck.id); i++) {
      c.nowMs += DT * 1000;
      H.tick();
    }
    expect(sim.objects.has(wreck.id)).toBe(false);
    sim.removeShip(salvager);
    const pods = [...sim.objects.values()].filter((o) => o.kind === EntityKind.Loot && o.info.c === GOOD);
    const inPods = pods.flatMap((o) => (o.data as { origins: CargoItem[] }).origins);
    expect(inPods.reduce((sum, it) => sum + it.n, 0)).toBe(5);
    expect(inPods.every((it) => it.sealed === true && it.origin === ID.H)).toBe(true);

    expect(await H.world.handleCommand(p, { k: 'respawn' })).toMatchObject({ ok: true });
    expect(hold(H, bot)).toEqual([]);
  });

  it('cargo washed through an honest partner in between arrives sealed at the third server', async () => {
    let bot = await newPilot(C, 'Washer');
    load(C, bot, [lot(4, ID.H), lot(4, ID.P), lot(4, ID.C)]);
    bot = await travel(bot, C, P);
    // The honest partner books its own label and the cheat's label to the cheat and seals the third label.
    expect(hold(P, bot)).toEqual([lot(4, ID.H, true), lot(8, ID.C)]);
    const imports = H.world.trade.ledger(ID.P).imports;
    bot = await travel(bot, P, H);
    // Home's own label arrives sealed (the partner sealed it), not as the partner's import.
    expect(hold(H, bot)).toEqual([lot(4, ID.H, true), lot(8, ID.C, true)]);
    const p = dock(H, bot);
    H.world.trade.creditIncome(p, 1_000_000, 'mission');
    expect(await sell(H, p, 12)).toMatchObject({ ok: false, err: expect.stringMatching(/sealed/) });
    expect(H.world.trade.ledger(ID.P).imports).toBe(imports);
  });

  it('shuttling the same goods out and back does not raise the allowance; neither does a ticket that is never redeemed', async () => {
    let bot = await newPilot(H, 'Shuttle');
    // A sealed lot rides along: it is never an export, and its mark survives every step below.
    const sealedFood: CargoItem = { c: 'food', n: 1, origin: ID.H, sealed: true };
    load(H, bot, [lot(10, ID.H), sealedFood]);
    const before = exportsTo(ID.P);
    const partnerBefore = P.world.trade.ledger(ID.H).exports;

    // A ticket is issued but never used: nothing is booked and the cargo comes back as it was.
    await depart(bot, H, P);
    expect(H.store.loadPlayer(bot.id)?.status).toBe('transit');
    expect(exportsTo(ID.P)).toBe(before);
    bot = c.track(await Bot.connect(H.url, { keys: bot.keys, name: bot.name }));
    await c.run(2);
    expect(hold(H, bot)).toEqual([lot(10, ID.H), sealedFood]);
    expect(exportsTo(ID.P)).toBe(before);

    // Out for real: booked once, when the partner redeems the ticket.
    bot = await travel(bot, H, P);
    expect(exportsTo(ID.P)).toBe(before + 10 * PRICE);
    expect(hold(P, bot)).toEqual([lot(10, ID.H), sealedFood]);
    // Back: Home's own goods return as the partner's import, not as local goods.
    bot = await travel(bot, P, H);
    expect(hold(H, bot)).toEqual([lot(10, ID.P), sealedFood]);
    // Out and back again with the same goods: nothing more is booked, on either side.
    bot = await travel(bot, H, P);
    bot = await travel(bot, P, H);
    expect(hold(H, bot)).toEqual([lot(10, ID.P), sealedFood]);
    expect(exportsTo(ID.P)).toBe(before + 10 * PRICE);
    expect(P.world.trade.ledger(ID.H).exports).toBe(partnerBefore);
  });

  it('imports stop at the credit line and resume after exports are redeemed', async () => {
    let bot = await newPilot(P, 'Importer');
    load(P, bot, [lot(12, ID.P)]);
    bot = await travel(bot, P, H);
    const p = dock(H, bot);
    const book = H.world.trade;
    book.creditIncome(p, 1_000_000, 'mission');
    const l = book.ledger(ID.P);
    const saved = H.config.tradeCredits[ID.P]!;
    // A credit line that leaves room for five tonnes and a little.
    H.config.tradeCredits[ID.P] = l.imports - l.exports + 5 * PRICE + 100;
    try {
      expect(book.allowance(ID.P)).toBe(5 * PRICE + 100);
      expect(await sell(H, p, 12)).toMatchObject({ ok: true, data: { n: 5, limit: 'allowance', limitOrigin: ID.P } });
      expect(book.allowance(ID.P)).toBe(100);
      expect(await sell(H, p, 7)).toMatchObject({ ok: false, err: expect.stringMatching(/trade balance with TPartner/) });
      expect(H.world.galaxyView().sectors.find((s) => s.id === ID.P)).toMatchObject({ trust: 'partner', tier: 'partner', rulesMatch: true, allowance: 100 });

      // A home pilot carries four tonnes of local goods to the partner.
      let exporter = await newPilot(H, 'Exporter');
      load(H, exporter, [lot(4, ID.H)]);
      exporter = await travel(exporter, H, P);
      expect(book.allowance(ID.P)).toBe(100 + 4 * PRICE);
      expect(await sell(H, p, 7)).toMatchObject({ ok: true, data: { n: 4, limit: 'allowance' } });
      expect(hold(H, bot)).toEqual([lot(3, ID.P)]);
    } finally {
      H.config.tradeCredits[ID.P] = saved;
    }
  });

  it('a pilot without non-trade income here cannot have imports absorbed; with income, up to the rate', async () => {
    let bot = await newPilot(P, 'Unlicensed');
    load(P, bot, [lot(10, ID.P)]);
    bot = await travel(bot, P, H);
    const p = dock(H, bot);
    expect(H.world.pilotView(p).licence).toEqual({ cap: 0, used: 0 });
    expect(await sell(H, p, 10)).toMatchObject({ ok: false, err: expect.stringMatching(/licence/) });
    // Trade revenue earns no licence.
    p.addCargo('food', 5, ID.H, false);
    expect(await sell(H, p, 5, 'food')).toMatchObject({ ok: true, data: { n: 5, limit: null } });
    expect(p.rec.credits).toBeGreaterThan(0);
    expect(await sell(H, p, 10)).toMatchObject({ ok: false, err: expect.stringMatching(/licence/) });

    H.world.trade.creditIncome(p, 3 * PRICE + 50, 'mission');
    expect(await sell(H, p, 10)).toMatchObject({ ok: true, data: { n: 3, limit: 'licence', limitOrigin: ID.P } });
    expect(H.world.pilotView(p).licence).toEqual({ cap: 3 * PRICE + 50, used: 3 * PRICE });
    H.config.importLicenceRate = 2;
    try {
      expect(await sell(H, p, 7)).toMatchObject({ ok: true, data: { n: 3, limit: 'licence' } });
      expect(H.world.pilotView(p).licence).toEqual({ cap: 6 * PRICE + 100, used: 6 * PRICE });
    } finally {
      H.config.importLicenceRate = 1;
    }
    expect(hold(H, bot)).toEqual([lot(4, ID.P)]);

    // A rating that is lowered later takes effect on goods already in the hold.
    H.world.trade.creditIncome(p, 1_000_000, 'mission');
    H.config.trust[ID.P] = 'visitor';
    try {
      expect(await sell(H, p, 4)).toMatchObject({ ok: false, err: expect.stringMatching(/sealed/) });
    } finally {
      H.config.trust[ID.P] = 'partner';
    }
    expect(await sell(H, p, 4)).toMatchObject({ ok: true, data: { n: 4, limit: null } });
  });

  it("a customs union exists only when mutual and the fingerprints match; a union member's label for a visitor stays sealed", async () => {
    expect(H.fed.tierOf(ID.U)).toBe('union');
    expect(U.fed.tierOf(ID.H)).toBe('union');
    // One-sided: Home rates the cheat union, the cheat's descriptor does not return it.
    H.config.trust[ID.C] = 'union';
    try {
      expect(H.fed.trustOf(ID.C)).toBe('union');
      expect(H.fed.tierOf(ID.C)).toBe('partner');
    } finally {
      delete H.config.trust[ID.C];
    }
    // Mutual, but the other side runs different rules.
    const known = H.fed.known.get(ID.U)!;
    const fingerprint = known.desc.trade.fingerprint;
    known.desc.trade.fingerprint = '0'.repeat(64);
    try {
      expect(H.fed.rulesMatch(ID.U)).toBe(false);
      expect(H.fed.tierOf(ID.U)).toBe('partner');
    } finally {
      known.desc.trade.fingerprint = fingerprint;
    }
    const sectors = H.world.galaxyView().sectors;
    expect(sectors.find((s) => s.id === ID.U)).toMatchObject({ trust: 'union', tier: 'union', rulesMatch: true, allowance: null });
    expect(sectors.find((s) => s.id === ID.C)).toMatchObject({ trust: 'visitor', tier: 'visitor', allowance: 0 });

    // The union member's labels are believed, but each is rated by Home's own tier for it.
    let bot = await newPilot(U, 'Unionist');
    load(U, bot, [lot(3, ID.U), lot(3, ID.H), lot(3, ID.C), lot(3, ID.P)]);
    bot = await travel(bot, U, H);
    expect(hold(H, bot)).toEqual([lot(3, ID.U), lot(3, ID.H), lot(3, ID.C, true), lot(3, ID.P)]);
    const p = dock(H, bot);
    // Nothing is bound on a ship that comes from inside the union.
    expect(isHullBound(p.rec)).toBe(false);
    // Without a licence: local and union goods pass, the partner's goods wait for one, the visitor's stay sealed.
    expect(await sell(H, p, 12)).toMatchObject({ ok: true, data: { n: 6, limit: 'licence', limitOrigin: ID.P } });
    expect(hold(H, bot)).toEqual([lot(3, ID.C, true), lot(3, ID.P)]);

    // Washing through the union: the cheat labels goods with Home's id and sends them via the union member.
    let washer = await newPilot(C, 'UnionWasher');
    load(C, washer, [lot(4, ID.H)]);
    washer = await travel(washer, C, U);
    expect(hold(U, washer)).toEqual([lot(4, ID.H, true)]);
    expect(isHullBound(playerOf(U, washer).rec)).toBe(true);
    washer = await travel(washer, U, H);
    expect(hold(H, washer)).toEqual([lot(4, ID.H, true)]);
    // The same for the ship: the union member holds it bound and says so in the ticket, and Home believes it.
    expect(isHullBound(playerOf(H, washer).rec)).toBe(true);
    expect(await sell(H, dock(H, washer), 4)).toMatchObject({ ok: false, err: expect.stringMatching(/sealed/) });
  });
});

describe('trade model: ships', () => {
  it('a ship is bound abroad, recognised as local when it comes back unchanged, and a changed module is bound', async () => {
    let bot = await newPilot(H, 'Homecomer');
    expect(H.world.pilotView(playerOf(H, bot)).shipBound).toBeNull();
    bot = await travel(bot, H, P);
    const abroad = P.world.pilotView(playerOf(P, bot)).shipBound!;
    expect(abroad.hull).toBe(true);
    expect(abroad.slots.every((x) => x)).toBe(true);
    bot = await travel(bot, P, H);
    let p = playerOf(H, bot);
    expect(H.world.pilotView(p).shipBound).toBeNull();
    expect(isHullBound(p.rec)).toBe(false);

    // Second trip: one module is replaced at the partner's.
    bot = await travel(bot, H, P);
    const lo = playerOf(P, bot).rec.passport.ship.loadout;
    const kinds = HULLS[lo.hull]!.slots;
    const slot = kinds.findIndex((kind, i) => Object.values(MODULES).some((m) => m.slot === kind && m.id !== lo.modules[i]));
    lo.modules[slot] = Object.values(MODULES).find((m) => m.slot === kinds[slot] && m.id !== lo.modules[slot])!.id;
    playerOf(P, bot).refit();
    bot = await travel(bot, P, H);
    p = playerOf(H, bot);
    const bound = H.world.pilotView(p).shipBound!;
    expect(bound.hull).toBe(false);
    expect(bound.slots.map((x, i) => (x ? i : -1)).filter((i) => i >= 0)).toEqual([slot]);
    expect(isSlotBound(p.rec, slot)).toBe(true);

    // Third trip: the hull is replaced. Nothing of it is recognised.
    bot = await travel(bot, H, P);
    playerOf(P, bot).rec.passport.ship.loadout = starterLoadout('delver');
    playerOf(P, bot).refit();
    bot = await travel(bot, P, H);
    const replaced = H.world.pilotView(playerOf(H, bot)).shipBound!;
    expect(replaced.hull).toBe(true);
    expect(replaced.slots.every((x) => x)).toBe(true);
  });

  it('a ship that left into the customs union is not recognised when it comes back from outside it', async () => {
    // Inside the union the ship is local and may be sold there, so a look-alike from elsewhere must not count as the same ship.
    let bot = await newPilot(H, 'UnionLeaver');
    bot = await travel(bot, H, U);
    expect(isHullBound(playerOf(U, bot).rec)).toBe(false);
    bot = await travel(bot, U, C);
    bot = await travel(bot, C, H);
    expect(isHullBound(playerOf(H, bot).rec)).toBe(true);
    // Out to the union and straight back: local on the union member's word.
    let direct = await newPilot(H, 'UnionReturner');
    direct = await travel(direct, H, U);
    direct = await travel(direct, U, H);
    expect(H.world.pilotView(playerOf(H, direct)).shipBound).toBeNull();
  });

  it('a ship above the class limit is refused at the origin, and at the destination when the origin does not check', async () => {
    // The cheat is a visitor at Home: nothing above the Drover class may enter from there.
    const bot = await newPilot(C, 'Dreadnought', 'bulwark');
    const p = playerOf(C, bot);
    const dest = C.fed.known.get(ID.H)!;
    expect(C.world.entryRefusal(p, dest)).toMatch(/THome admits ships up to the Drover class from visitor sectors/);
    expect(C.world.handoff(p, dest, { kind: 'fold', system: `${ID.H}:0` })).toMatchObject({ ok: false, err: expect.stringMatching(/Bulwark is above that class/) });
    // A fold drive that finishes charging does not jump either: no fuel is spent, nothing is counted.
    const ship = p.ship!;
    const fuel = ship.state.fuel;
    ship.fold = { system: `${ID.H}:0`, server: ID.H, distance: 1 };
    C.world.startFold(ship, p.sim!);
    expect(ship.state.fuel).toBe(fuel);
    expect(p.rec.passport.stats.jumps).toBe(0);
    expect(C.world.players.has(bot.id)).toBe(true);
    expect(C.store.loadPlayer(bot.id)?.status ?? 'here').toBe('here');
    await c.settle(() => bot.notices.some((n) => n.code === 'fold_refused'), 'the refusal notice');

    // A dishonest origin skips the check: the destination refuses before the ticket is redeemed.
    const world = C.world as { entryRefusal?: unknown };
    world.entryRefusal = () => null;
    try {
      await depart(bot, C, H);
    } finally {
      delete world.entryRefusal;
    }
    const res = await refused(H.url, { keys: bot.keys, name: bot.name, ticket: bot.handoff!.ticket });
    expect(res.authFail).toMatchObject({ code: 'ticket' });
    expect(res.authFail!.msg).toMatch(/THome admits ships up to the Drover class from visitor sectors/);
    expect(H.store.loadPlayer(bot.id)).toBeUndefined();
    // The pilot is still in transit at the origin and gets the ship back there.
    expect(C.store.loadPlayer(bot.id)?.status).toBe('transit');
    const back = c.track(await Bot.connect(C.url, { keys: bot.keys, name: bot.name }));
    await c.run(2);
    expect(C.store.loadPlayer(bot.id)?.status).toBe('here');
    expect(back.pilot?.passport.ship.loadout.hull).toBe('bulwark');

    // A ship Home recognises as its own is exempt: a home pilot takes a Bulwark to the cheat and back.
    let home = await newPilot(H, 'Flagship', 'bulwark');
    home = await travel(home, H, C);
    home = await travel(home, C, H);
    expect(H.world.players.has(home.id)).toBe(true);
    expect(isHullBound(playerOf(H, home).rec)).toBe(false);
  });
});

describe('trade model: recall', () => {
  it('a ship recalled because its destination went silent takes its export back', async () => {
    const bot = await newPilot(H, 'Recalled');
    load(H, bot, [lot(5, ID.H)]);
    const before = exportsTo(ID.P);
    const away = await travel(bot, H, P);
    expect(exportsTo(ID.P)).toBe(before + 5 * PRICE);
    away.close();
    c.bots.delete(away);
    // The partner redeemed the ticket and then stops answering for longer than the recall time.
    c.nowMs += PEER_TIMEOUT_MS * 4 + 1_000;
    const back = c.track(await Bot.connect(H.url, { keys: bot.keys, name: bot.name }));
    await c.run(2);
    expect(hold(H, back)).toEqual([lot(5, ID.H)]);
    expect(exportsTo(ID.P)).toBe(before);
  });
});
