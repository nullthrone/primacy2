/**
 * Review of the trade model from the side of the attacker and of the honest pilot: what a pilot
 * with a modified client and an operator with a modified server can still turn into value on an
 * honest server, and what an honest round trip costs. Home is the server under test, Partner is
 * rated partner, Cheat is not rated (a visitor).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMODITIES,
  FlightMode,
  HULLS,
  MODULES,
  idFromPublicKey,
  starterLoadout,
  type CargoItem,
} from '@primacy2/shared';
import { isHullBound, isSlotBound, makeConfig, type CommandResult, type Player, type PrimacyServer } from '@primacy2/server';
import { KG_PER_SCRAP_TONNE, PART_CHANCE, PART_FOR_SLOT } from '../packages/server/src/modules/salvage.ts';
import { deductible } from '../packages/server/src/modules/insurance.ts';
import { Bot } from './bot.ts';
import { Cluster, testKeys } from './harness.ts';

const c = new Cluster();
const idOf = (name: string): string => idFromPublicKey(testKeys(name).publicKey);
const ID = { H: idOf('RHome'), P: idOf('RPartner'), C: idOf('RCheat') };
let H: PrimacyServer;
let P: PrimacyServer;
let C: PrimacyServer;

const GOOD = 'medicine';
const PRICE = COMMODITIES[GOOD]!.price;
const lot = (n: number, origin: string, sealed = false, good = GOOD): CargoItem =>
  sealed ? { c: good, n, origin, sealed: true } : { c: good, n, origin };

const playerOf = (s: PrimacyServer, bot: Bot): Player => s.world.players.get(bot.id)!;
const hold = (s: PrimacyServer, bot: Bot): CargoItem[] => playerOf(s, bot).rec.passport.ship.cargo;
const byOrigin = (lots: CargoItem[]): CargoItem[] => [...lots].sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0));
const sell = (s: PrimacyServer, p: Player, n: number, good = GOOD): Promise<CommandResult> => s.world.handleCommand(p, { k: 'sell', c: good, n });
const exportsTo = (peer: string): number => H.world.trade.ledger(peer).exports;

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

async function depart(bot: Bot, from: PrimacyServer, to: PrimacyServer): Promise<void> {
  const res = from.world.handoff(playerOf(from, bot), from.fed.known.get(to.id)!, { kind: 'fold', system: `${to.id}:0` });
  expect(res).toEqual({ ok: true });
  await c.settle(() => bot.handoff !== null, 'handoff message');
  c.bots.delete(bot);
  bot.close();
}

async function travel(bot: Bot, from: PrimacyServer, to: PrimacyServer): Promise<Bot> {
  await depart(bot, from, to);
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

beforeAll(async () => {
  const base = { maxConnectionsPerIp: 500 };
  H = await c.start({ ...base, name: 'RHome', seed: 'rhome', trust: { [ID.P]: 'partner' }, tradeCredits: { [ID.P]: 1_000_000 } });
  P = await c.start({ ...base, name: 'RPartner', seed: 'rpartner', peers: [H.url], trust: { [ID.H]: 'partner', [ID.C]: 'partner' } });
  C = await c.start({ ...base, name: 'RCheat', seed: 'rcheat', peers: [H.url, P.url], defaultTrust: 'partner' });
  await P.peer();
  await C.peer();
  for (const s of [H, P, C]) s.world.modules.splice(s.world.modules.findIndex((m) => m.name === 'npc'), 1);
});

afterAll(async () => {
  await c.stop();
});

describe('review: the honest pilot', () => {
  it('flies out with his own goods and ship and back, and loses nothing: goods sell without licence, the export is not left behind', async () => {
    let bot = await newPilot(H, 'Honest');
    load(H, bot, [lot(10, ID.H)]);
    const before = exportsTo(ID.P);
    const imports = H.world.trade.ledger(ID.P).imports;
    for (let trip = 0; trip < 2; trip++) {
      bot = await travel(bot, H, P);
      expect(exportsTo(ID.P)).toBe(before + 10 * PRICE);
      bot = await travel(bot, P, H);
      // The goods are back where they were made, so no allowance stays booked for them.
      expect(exportsTo(ID.P)).toBe(before);
    }
    expect(hold(H, bot)).toEqual([lot(10, ID.H)]);
    const p = dock(H, bot);
    expect(isHullBound(p.rec)).toBe(false);
    expect(H.world.pilotView(p).licence).toEqual({ cap: 0, used: 0 });
    expect(await sell(H, p, 10)).toMatchObject({ ok: true, data: { n: 10, limit: null } });
    expect(H.world.trade.ledger(ID.P).imports).toBe(imports);
  });

  it('what a partner hands back is recognised only up to the local value the pilot left with', async () => {
    let bot = await newPilot(H, 'Swapped');
    load(H, bot, [lot(2, ID.H, false, 'iron_ore')]);
    bot = await travel(bot, H, P);
    // The partner's operator takes the ore and hands back dearer goods that carry Home's label.
    load(P, bot, [lot(5, ID.H)]);
    bot = await travel(bot, P, H);
    expect(hold(H, bot)).toEqual([lot(5, ID.P)]);

    // The same pilot leaves with ten tonnes and comes back with twenty: ten are his, ten are imports.
    load(H, bot, [lot(10, ID.H)]);
    bot = await travel(bot, H, P);
    load(P, bot, [lot(20, ID.H)]);
    bot = await travel(bot, P, H);
    expect(byOrigin(hold(H, bot))).toEqual(byOrigin([lot(10, ID.H), lot(10, ID.P)]));
  });

  it('a sealed lot is never recognised as the pilot\'s own', async () => {
    let bot = await newPilot(H, 'SealedBack');
    load(H, bot, [lot(4, ID.H)]);
    bot = await travel(bot, H, P);
    load(P, bot, [lot(4, ID.H, true)]);
    bot = await travel(bot, P, H);
    expect(hold(H, bot)).toEqual([lot(4, ID.H, true)]);
  });

  it('a ticket that is voided leaves no recognition behind', async () => {
    let bot = await newPilot(H, 'Voided');
    load(H, bot, [lot(6, ID.H)]);
    await depart(bot, H, P);
    bot = c.track(await Bot.connect(H.url, { keys: bot.keys, name: bot.name }));
    await c.run(2);
    expect(H.store.loadPlayer(bot.id)?.data.departed).toBeUndefined();
  });
});

describe('review: tickets', () => {
  it('a ticket is redeemed once, by its destination only, and not after it expired', async () => {
    const bot = await newPilot(H, 'Redeemer');
    load(H, bot, [lot(3, ID.H)]);
    const before = exportsTo(ID.P);
    await depart(bot, H, P);
    const rec = H.store.loadPlayer(bot.id)!;
    const nonce = rec.away!.nonce;
    expect(H.world.redeemTicket(ID.C, nonce, bot.id)).toBe(false);
    expect(H.world.redeemTicket(ID.P, 'x'.repeat(16), bot.id)).toBe(false);
    expect(exportsTo(ID.P)).toBe(before);
    expect(H.world.redeemTicket(ID.P, nonce, bot.id)).toBe(true);
    expect(H.world.redeemTicket(ID.P, nonce, bot.id)).toBe(true);
    expect(exportsTo(ID.P)).toBe(before + 3 * PRICE);
    expect(exportsTo(ID.C)).toBe(0);

    const late = await newPilot(H, 'Late');
    load(H, late, [lot(3, ID.H)]);
    await depart(late, H, P);
    const lr = H.store.loadPlayer(late.id)!;
    lr.away!.expiresAt = c.nowMs - 61_000;
    H.store.savePlayer(lr);
    expect(H.world.redeemTicket(ID.P, lr.away!.nonce, late.id)).toBe(false);
    expect(exportsTo(ID.P)).toBe(before + 3 * PRICE);
  });
});

describe('review: ships', () => {
  it('a free starter ship issued after a death is not worth credits: nothing refunds when it is sold or swapped', async () => {
    const bot = await newPilot(H, 'Broke');
    const p = dock(H, bot);
    p.rec.credits = 0;
    p.ship!.state.mode = FlightMode.Dead;
    expect(await H.world.handleCommand(p, { k: 'respawn' })).toMatchObject({ ok: true, data: { starter: true } });
    expect(p.rec.passport.ship.loadout).toEqual(starterLoadout());
    dock(H, bot);
    const stock = HULLS[starterLoadout().hull]!.stock;
    const slot = stock.findIndex((m, i) => m !== null && HULLS[starterLoadout().hull]!.slots[i] === 'utility');
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(isSlotBound(p.rec, slot)).toBe(true);
    expect(await H.world.handleCommand(p, { k: 'fit', slot, module: null })).toMatchObject({ ok: true, data: { refund: 0 } });
    expect(p.rec.credits).toBe(0);
  });

  it('the scrap and parts of an insured ship are worth less than its deductible for every hull and every fit', () => {
    const rate = makeConfig({}).insuranceRate;
    const worth = (id: string): number => COMMODITIES[id]?.price ?? 0;
    for (const hull of Object.values(HULLS)) {
      const scrap = Math.max(1, Math.round(hull.mass / KG_PER_SCRAP_TONNE)) * worth('scrap');
      // The best fit for a wreck: per slot the module whose expected parts exceed its share of the deductible by most.
      let gain = scrap - hull.price * rate;
      for (const slot of hull.slots) {
        let best = slot === 'weapon' || slot === 'utility' ? 0 : -Infinity;
        for (const m of Object.values(MODULES)) {
          if (m.slot === slot) best = Math.max(best, PART_CHANCE * worth(PART_FOR_SLOT[slot] ?? 'alloys') - m.price * rate);
        }
        gain += best;
      }
      expect(gain, hull.id).toBeLessThan(0);
      // The stock fit as well, exactly as the game computes the deductible.
      const lo = { hull: hull.id, modules: [...hull.stock] };
      const yielded = scrap + hull.stock.reduce((s, m, i) => s + (m ? PART_CHANCE * worth(PART_FOR_SLOT[hull.slots[i]!] ?? 'alloys') : 0), 0);
      expect(yielded, hull.id).toBeLessThan(deductible(lo, rate));
    }
  });
});
