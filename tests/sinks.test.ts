/**
 * Every place where cargo is turned into value (sales, missions, gate projects), every source of
 * non-trade income that feeds the import licence, and the ship rules in the shipyard modules.
 * Home is the server under test, Partner is rated partner, Cheat is not rated (a visitor).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMODITIES,
  FlightMode,
  Button,
  computeShipStats,
  idFromPublicKey,
  newShipState,
  quat,
  starterLoadout,
  tradeUnits,
  v3,
  type CargoItem,
} from '@primacy2/shared';
import { newShip, type CommandResult, type Player, type PrimacyServer } from '@primacy2/server';
import { gateProjects } from '../packages/server/src/modules/gates.ts';
import { onKill, lawOf } from '../packages/server/src/modules/combat/law.ts';
import { wreckData } from '../packages/server/src/modules/salvage.ts';
import { Bot } from './bot.ts';
import { Cluster, testKeys } from './harness.ts';

const c = new Cluster();
const idOf = (name: string): string => idFromPublicKey(testKeys(name).publicKey);
const ID = { H: idOf('SHome'), P: idOf('SPartner'), C: idOf('SCheat') };
let H: PrimacyServer;
let P: PrimacyServer;
let C: PrimacyServer;

const GOOD = 'medicine';
const PRICE = COMMODITIES[GOOD]!.price;
const ORE = 'iron_ore';

const playerOf = (s: PrimacyServer, bot: Bot): Player => s.world.players.get(bot.id)!;
const hold = (s: PrimacyServer, bot: Bot): CargoItem[] => playerOf(s, bot).rec.passport.ship.cargo;
const run = (s: PrimacyServer, p: Player, cmd: Parameters<PrimacyServer['world']['handleCommand']>[1]): Promise<CommandResult> => s.world.handleCommand(p, cmd);
const tonnes = (lots: CargoItem[], good: string): number => lots.filter((l) => l.c === good).reduce((sum, l) => sum + l.n, 0);

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

function load(s: PrimacyServer, bot: Bot, lots: CargoItem[]): void {
  const cargo = hold(s, bot);
  cargo.length = 0;
  cargo.push(...lots.map((x) => ({ ...x })));
}

async function travel(bot: Bot, from: PrimacyServer, to: PrimacyServer): Promise<Bot> {
  expect(from.world.handoff(playerOf(from, bot), from.fed.known.get(to.id)!, { kind: 'fold', system: `${to.id}:0` })).toEqual({ ok: true });
  await c.settle(() => bot.handoff !== null, 'handoff message');
  c.bots.delete(bot);
  bot.close();
  const next = c.track(await Bot.connect(to.url, { keys: bot.keys, name: bot.name, ticket: bot.handoff!.ticket }));
  await c.run(2);
  return next;
}

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

/** Puts a mission into the pilot's log as if it had been accepted at the capital. */
function giveMission(s: PrimacyServer, p: Player, m: Record<string, unknown>): string {
  const at = s.world.capital();
  const id = `test/${Math.random().toString(36).slice(2)}`;
  const log = (p.rec.data.missions ??= { active: [], done: [] }) as { active: unknown[] };
  log.active.push({
    id, kind: 'delivery', title: 'test', text: '', deposit: 0, reward: 1000, accepted: true, system: p.sim!.def.id, site: at.site.id,
    destSystem: p.sim!.def.id, destSite: at.site.id, destName: 'here', expires: p.sim!.time + 10_000, ...m,
  });
  return id;
}

const licenceOf = (s: PrimacyServer, p: Player): { cap: number; used: number } => s.world.pilotView(p).licence;

beforeAll(async () => {
  const base = { maxConnectionsPerIp: 500 };
  H = await c.start({
    ...base, name: 'SHome', seed: 'shome', gateCostScale: 0.001, gates: [{ peer: ID.P, system: 0 }],
    trust: { [ID.P]: 'partner' }, tradeCredits: { [ID.P]: 1_000_000 },
  });
  P = await c.start({ ...base, name: 'SPartner', seed: 'spartner', peers: [H.url], trust: { [ID.H]: 'partner', [ID.C]: 'partner' }, gateCostScale: 0.001 });
  C = await c.start({ ...base, name: 'SCheat', seed: 'scheat', peers: [H.url, P.url], defaultTrust: 'partner' });
  await P.peer();
  await C.peer();
  for (const s of [H, P, C]) s.world.modules.splice(s.world.modules.findIndex((m) => m.name === 'npc'), 1);
  await c.until(() => gateProjects(H.world).length === 1, 'gate project at Home', 600);
});

afterAll(async () => {
  await c.stop();
});

describe('sinks: sealed cargo', () => {
  it("a visitor's sealed cargo cannot complete a mission, fund a gate or be sold, however large the licence", async () => {
    const project = gateProjects(H.world)[0]!;
    let bot = await newPilot(C, 'Smuggler');
    load(C, bot, [{ c: GOOD, n: 6, origin: ID.H }, { c: ORE, n: 8, origin: ID.H }, { c: 'food', n: 4, origin: ID.H }]);
    bot = await travel(bot, C, H);
    const p = dock(H, bot);
    expect(hold(H, bot).every((it) => it.sealed === true)).toBe(true);
    H.world.trade.creditIncome(p, 10_000_000, 'mission');
    p.rec.credits = 100_000;
    const before = structuredClone(hold(H, bot));
    const gate = H.world.stationView(p)!.gateProjects[0]!;
    const material = Object.keys(gate.needMaterials)[0]!;
    p.rec.passport.ship.cargo.push({ c: material, n: 3, origin: ID.H, sealed: true });
    before.push({ c: material, n: 3, origin: ID.H, sealed: true });

    const delivery = giveMission(H, p, { kind: 'delivery', c: GOOD, n: 6, deposit: 100 });
    const mining = giveMission(H, p, { kind: 'mining', c: ORE, n: 8 });
    for (const id of [delivery, mining]) {
      expect(await run(H, p, { k: 'missionComplete', id }), id).toMatchObject({ ok: false, err: expect.stringMatching(/sealed/) });
    }
    expect(await run(H, p, { k: 'gateFund', linkId: project.linkId, c: material, n: 3 })).toMatchObject({ ok: false, err: expect.stringMatching(/sealed/) });
    expect(await run(H, p, { k: 'sell', c: 'food', n: 4 })).toMatchObject({ ok: false, err: expect.stringMatching(/sealed/) });
    expect(project.paidMaterials[material] ?? 0).toBe(0);
    expect(p.rec.credits).toBe(100_000);
    expect(hold(H, bot)).toEqual(before);
    expect(licenceOf(H, p).used).toBe(0);
  });

  it('a shipment that is partly sealed fails a delivery and takes nothing', async () => {
    let bot = await newPilot(C, 'Mixed');
    load(C, bot, [{ c: GOOD, n: 3, origin: ID.C }]);
    bot = await travel(bot, C, H);
    const p = dock(H, bot);
    p.addCargo(GOOD, 3, ID.H, false);
    const id = giveMission(H, p, { kind: 'delivery', c: GOOD, n: 6 });
    expect(await run(H, p, { k: 'missionComplete', id })).toMatchObject({ ok: false, err: expect.stringMatching(/sealed/) });
    expect(tonnes(hold(H, bot), GOOD)).toBe(6);
    // The local half alone does complete a delivery of 3.
    const small = giveMission(H, p, { kind: 'delivery', c: GOOD, n: 3, reward: 700 });
    expect(await run(H, p, { k: 'missionComplete', id: small })).toMatchObject({ ok: true });
    expect(hold(H, bot)).toEqual([{ c: GOOD, n: 3, origin: ID.C, sealed: true }]);
  });
});

describe('sinks: imports and the licence', () => {
  it('a delivery with partner goods needs a licence that missions earn, and counts only the reward', async () => {
    let bot = await newPilot(P, 'Courier');
    load(P, bot, [{ c: GOOD, n: 4, origin: ID.P }]);
    bot = await travel(bot, P, H);
    const p = dock(H, bot);
    p.rec.credits = 5000;
    const id = giveMission(H, p, { kind: 'delivery', c: GOOD, n: 4, reward: 900 });
    expect(await run(H, p, { k: 'missionComplete', id })).toMatchObject({ ok: false, err: expect.stringMatching(/licence/) });
    expect(hold(H, bot)).toEqual([{ c: GOOD, n: 4, origin: ID.P }]);

    // A bounty job pays a reward; the licence grows by exactly that reward.
    const bounty = giveMission(H, p, { kind: 'bounty', n: 2, progress: 2, reward: 4 * PRICE + 10, destName: 'x' });
    expect(await run(H, p, { k: 'missionComplete', id: bounty })).toMatchObject({ ok: true });
    expect(licenceOf(H, p)).toEqual({ cap: 4 * PRICE + 10, used: 0 });

    expect(await run(H, p, { k: 'missionComplete', id })).toMatchObject({ ok: true });
    expect(hold(H, bot)).toEqual([]);
    // The shipment was the partner's goods, so its reward (900) is trade revenue and earns no licence.
    expect(licenceOf(H, p)).toEqual({ cap: 4 * PRICE + 10, used: 4 * PRICE });
    expect(H.world.trade.ledger(ID.P).imports).toBeGreaterThanOrEqual(4 * PRICE);
  });

  it('imported ore handed in for a mining mission does not feed the licence it uses; only the share made here counts', async () => {
    let bot = await newPilot(P, 'OreRunner');
    load(P, bot, [{ c: ORE, n: 6, origin: ID.P }]);
    bot = await travel(bot, P, H);
    const p = dock(H, bot);
    const ore = COMMODITIES[ORE]!.price;
    H.world.trade.creditIncome(p, 6 * ore, 'bounty');
    // Two missions of two tonnes each, paying well above the ore's value as mining missions do.
    const reward = Math.round(2 * ore * 1.7);
    for (let i = 0; i < 2; i++) {
      const id = giveMission(H, p, { kind: 'mining', c: ORE, n: 2, reward });
      expect(await run(H, p, { k: 'missionComplete', id })).toMatchObject({ ok: true });
    }
    expect(licenceOf(H, p)).toEqual({ cap: 6 * ore, used: 4 * ore });
    // One tonne mined here and one imported: half the reward is income.
    load(H, bot, [{ c: ORE, n: 1, origin: ID.H }, { c: ORE, n: 1, origin: ID.P }]);
    const mixed = giveMission(H, p, { kind: 'mining', c: ORE, n: 2, reward: 1000 });
    expect(await run(H, p, { k: 'missionComplete', id: mixed })).toMatchObject({ ok: true });
    expect(licenceOf(H, p)).toEqual({ cap: 6 * ore + 500, used: 5 * ore });
  });

  it('the deposit of a delivery is not income; only the reward is', async () => {
    const bot = await newPilot(H, 'Depositor');
    const p = dock(H, bot);
    p.addCargo(GOOD, 2, ID.H, false);
    const id = giveMission(H, p, { kind: 'delivery', c: GOOD, n: 2, deposit: 5000, reward: 300 });
    expect(await run(H, p, { k: 'missionComplete', id })).toMatchObject({ ok: true, data: { credits: 5300 } });
    expect(licenceOf(H, p)).toEqual({ cap: 300, used: 0 });
  });

  it('a gate donation takes imports against the licence and the partner balance, and uses what was taken', async () => {
    const project = gateProjects(H.world)[0]!;
    let bot = await newPilot(P, 'Builder');
    bot = await travel(bot, P, H);
    const p = dock(H, bot);
    const needs = H.world.stationView(p)!.gateProjects[0]!.needMaterials;
    const material = Object.keys(needs).find((m) => needs[m]! >= 2) ?? Object.keys(needs)[0]!;
    const taken = Math.min(2, needs[material]!);
    const price = COMMODITIES[material]!.price;
    load(H, bot, [{ c: material, n: 5, origin: ID.P }]);
    expect(await run(H, p, { k: 'gateFund', linkId: project.linkId, c: material, n: 5 })).toMatchObject({ ok: false, err: expect.stringMatching(/licence/) });
    H.world.trade.creditIncome(p, 2 * price + 1, 'mission');
    const paid = project.paidMaterials[material] ?? 0;
    expect(await run(H, p, { k: 'gateFund', linkId: project.linkId, c: material, n: 5 })).toMatchObject({ ok: true });
    // The gate takes no more than it needs and the licence covers 2 t: the smaller of the two is used.
    expect(project.paidMaterials[material]! - paid).toBe(taken);
    expect(hold(H, bot)).toEqual([{ c: material, n: 5 - taken, origin: ID.P }]);
    expect(licenceOf(H, p).used).toBe(taken * price);
  });

  it('survey data counts as income when it is sold', async () => {
    const bot = await newPilot(H, 'Surveyor');
    const p = dock(H, bot);
    const sim = p.sim!;
    const site = sim.def.sites.find((s) => s.services?.includes('cartography'));
    if (!site) return;
    p.ship!.state.anchor = site.id;
    const body = sim.def.bodies.find((b) => b.kind !== 'star')!;
    (p.rec.data.exploration ??= { scans: [], sold: [] }) as { scans: unknown[] };
    (p.rec.data.exploration as { scans: unknown[] }).scans.push({ key: `${sim.def.id}/${body.id}`, first: true });
    const credits = p.rec.credits;
    expect(await run(H, p, { k: 'sellData' })).toMatchObject({ ok: true });
    const paid = p.rec.credits - credits;
    expect(paid).toBeGreaterThan(0);
    expect(licenceOf(H, p).cap).toBe(paid);
  });

  it('a bounty on an NPC counts as income, a bounty on a pilot does not', async () => {
    const killerBot = await newPilot(H, 'Hunter');
    const victimBot = await newPilot(H, 'Outlaw');
    const killer = playerOf(H, killerBot);
    const victim = playerOf(H, victimBot);
    const sim = killer.sim!;
    const npc = newShip(H.world.allocId(), 'Pirate', starterLoadout('drover'), computeShipStats(starterLoadout('drover')), newShipState(computeShipStats(starterLoadout('drover'))));
    (npc as { brain: unknown }).brain = { bounty: 400 };
    onKill(sim, killer.ship!, npc);
    expect(licenceOf(H, killer)).toEqual({ cap: 400, used: 0 });

    lawOf(victim).bounty = 900;
    lawOf(victim).wantedUntil = sim.time + 1000;
    const before = killer.rec.credits;
    onKill(sim, killer.ship!, victim.ship!);
    expect(killer.rec.credits).toBe(before + 900);
    expect(licenceOf(H, killer).cap).toBe(400);
  });

  it('ore mined here is credited in trade units when the laser cuts it', async () => {
    const bot = await newPilot(H, 'Miner', 'delver');
    const p = playerOf(H, bot);
    const def = [...H.world.defs.values()].find((d) => d.sites.some((s) => s.kind === 'belt'))!;
    const site = def.sites.find((s) => s.kind === 'belt')!;
    const sim = H.world.sim(def.id);
    const rock = sim.asteroids(site.id).find((r) => r.radius > 40)!;
    // A ship in the belt that belongs to the pilot: the laser credits the pilot it belongs to.
    const loadout = starterLoadout('delver');
    const stats = computeShipStats(loadout);
    const state = newShipState(stats);
    const dir = v3.normalize(rock.pos.some((x) => x !== 0) ? rock.pos : [1, 0, 0]);
    state.anchor = site.id;
    state.pos = v3.addScaled(rock.pos, dir, rock.radius + 150);
    state.rot = quat.lookRotation(v3.neg(dir));
    const live = newShip(H.world.allocId(), 'Miner Ship', loadout, stats, state);
    live.player = p;
    live.input.buttons = Button.Fire3;
    sim.addShip(live);
    expect(licenceOf(H, p).cap).toBe(0);
    await c.run(300);
    sim.removeShip(live);
    const mined = p.rec.passport.stats.mined;
    expect(mined).toBeGreaterThan(0);
    expect(licenceOf(H, p).cap).toBeCloseTo(tradeUnits(rock.ore, 1) * mined, 6);
  });
});

describe('sinks: ships', () => {
  it('the wreck of a bound ship yields neither scrap nor parts; an unbound hull yields scrap; bound modules yield no parts', async () => {
    let bot = await newPilot(P, 'Foreigner', 'delver');
    load(P, bot, []);
    bot = await travel(bot, P, H);
    let p = dock(H, bot);
    expect(H.world.pilotView(p).shipBound?.hull).toBe(true);
    expect(await run(H, p, { k: 'undock' })).toMatchObject({ ok: true });
    const wreckContents = (name: string): CargoItem[] => {
      const w = [...p.sim!.objects.values()].filter((o) => o.info.name === `Wreck of ${name}` && wreckData(o));
      return wreckData(w[w.length - 1]!)!.contents;
    };
    p.sim!.destroy(p.ship!, null);
    expect(wreckContents(p.name)).toEqual([]);

    // A home pilot's hull is his own: scrap. Every module bound: no parts.
    const home = await newPilot(H, 'Homebody', 'delver');
    p = playerOf(H, home);
    load(H, home, []);
    const lo = p.rec.passport.ship.loadout;
    p.rec.data.customs = {
      issuer: ID.P, trust: 'partner', at: 0, loadout: structuredClone(lo), bound: { hull: false, slots: lo.modules.map(() => true) },
    };
    dock(H, home);
    expect(await run(H, p, { k: 'undock' })).toMatchObject({ ok: true });
    p.sim!.destroy(p.ship!, null);
    const contents = wreckContents(p.name);
    expect(contents.map((x) => x.c)).toEqual(['scrap']);
  });

  it('a respawn keeps a bound ship bound; the free starter is a handout and stays bound', async () => {
    let bot = await newPilot(P, 'Insured', 'delver');
    bot = await travel(bot, P, H);
    const p = dock(H, bot);
    await run(H, p, { k: 'undock' });
    p.sim!.destroy(p.ship!, null);
    p.rec.credits = 1_000_000;
    expect(await run(H, p, { k: 'respawn' })).toMatchObject({ ok: true, data: { starter: false } });
    expect(H.world.pilotView(p).shipBound?.hull).toBe(true);

    dock(H, bot);
    await run(H, p, { k: 'undock' });
    p.sim!.destroy(p.ship!, null);
    p.rec.credits = 0;
    expect(await run(H, p, { k: 'respawn' })).toMatchObject({ ok: true, data: { starter: true } });
    // Nothing the free starter carries is worth credits (tests/review.test.ts checks the refund).
    expect(H.world.pilotView(p).shipBound?.hull).toBe(true);
    expect(H.world.pilotView(p).shipBound?.slots.every(Boolean)).toBe(true);
  });

  it('the fold command refuses a hull above the destination class limit before the charge starts', async () => {
    const bot = await newPilot(C, 'Dreadnought', 'bulwark');
    const p = dock(C, bot);
    expect(await run(C, p, { k: 'undock' })).toMatchObject({ ok: true });
    const fuel = p.ship!.state.fuel;
    expect(await run(C, p, { k: 'fold', system: `${ID.H}:0` })).toMatchObject({ ok: false, err: expect.stringMatching(/admits ships up to the Drover class/) });
    expect(p.ship!.fold).toBeFalsy();
    expect(p.ship!.state.fuel).toBe(fuel);
  });
});
