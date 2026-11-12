/**
 * Integration tests for the gameplay modules that span servers or need a whole world:
 * galaxy chat, exploration, missions, mining and warp gates.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Button,
  EntityKind,
  FlightMode,
  GATE_COST,
  computeShipStats,
  idFromPublicKey,
  newShipState,
  quat,
  starterLoadout,
  v3,
  verifyDescriptor,
} from '@primacy2/shared';
import { newShip, type PrimacyServer } from '@primacy2/server';
import { gateProjects } from '../packages/server/src/modules/gates.ts';
import { Bot } from './bot.ts';
import { Cluster, testKeys } from './harness.ts';

const c = new Cluster();
let A: PrimacyServer;
let B: PrimacyServer;
let ada: Bot;
let bob: Bot;

async function cmd(b: Bot, command: Parameters<Bot['cmd']>[0]) {
  // Let simulated time pass between commands; the server limits commands per second of its clock.
  await c.run(2);
  let reply: Awaited<ReturnType<Bot['cmd']>> | null = null;
  void b.cmd(command).then((r) => (reply = r));
  await c.settle(() => reply !== null, `reply to ${command.k}`);
  return reply!;
}

beforeAll(async () => {
  const bId = idFromPublicKey(testKeys('GBeta').publicKey);
  // Gates are made cheap here; the full price is checked separately below.
  A = await c.start({ name: 'GAlpha', seed: 'galpha', gateCostScale: 0.001, gates: [{ peer: bId, system: 0 }] });
  B = await c.start({ name: 'GBeta', seed: 'gbeta', gateCostScale: 0.001, peers: [A.url] });
  await B.peer();
  ada = c.track(await Bot.connect(A.url, { name: 'Ada' }));
  bob = c.track(await Bot.connect(B.url, { name: 'Bob' }));
  await c.run(4);
});

afterAll(async () => {
  await c.stop();
});

describe('galaxy chat', () => {
  it('relays a message to the linked server and marks where it came from', async () => {
    expect(await cmd(ada, { k: 'chat', ch: 'lattice', text: 'hello  from‮ alpha' })).toMatchObject({ ok: true });
    await c.settle(() => bob.chats.some((m) => m.ch === 'lattice'), 'relayed chat');
    const m = bob.chats.find((x) => x.ch === 'lattice')!;
    expect(m.text).toBe('hello from alpha');
    expect(m.from).toMatchObject({ name: 'Ada', server: A.id });
    // The author sees it once, locally.
    expect(ada.chats.filter((x) => x.ch === 'lattice')).toHaveLength(1);
  });

  it('does not relay sector chat', async () => {
    const before = bob.chats.length;
    expect(await cmd(ada, { k: 'chat', ch: 'sector', text: 'local business' })).toMatchObject({ ok: true });
    await c.run(10);
    expect(bob.chats.length).toBe(before);
  });
});

describe('exploration', () => {
  it('surveys a body once, records the first discovery and pays at a station', async () => {
    const player = A.world.players.get(ada.id)!;
    expect(await cmd(ada, { k: 'scan', body: 0 })).toMatchObject({ ok: false });

    // Fit a scanner and move the ship next to the primary.
    player.rec.passport.ship.loadout.modules[7] = 'scanner_1';
    player.refit();
    const ship = player.ship!;
    const star = player.sim!.def.bodies[0]!;
    const dockedAt = ship.state.anchor;
    ship.state.mode = FlightMode.Cruise;
    ship.state.anchor = 0;
    ship.state.pos = [star.radius * 20, 0, 0];
    await c.run(2);
    const first = await cmd(ada, { k: 'scan', body: 0 });
    expect(first).toMatchObject({ ok: true, data: { first: true } });
    expect(await cmd(ada, { k: 'scan', body: 0 })).toMatchObject({ ok: false });
    expect(await cmd(ada, { k: 'scan', body: 999 })).toMatchObject({ ok: false });
    expect(await cmd(ada, { k: 'sellData' })).toMatchObject({ ok: false });
    await c.run(2);
    expect(ada.pilot!.scans).toEqual([[player.sim!.def.id, 0]]);
    expect(ada.pilot!.passport.stats.discoveries).toBe(1);

    // Back at the station the data sells, once.
    ship.state.mode = FlightMode.Docked;
    ship.state.anchor = dockedAt;
    ship.state.pos = [0, 0, 0];
    await c.run(2);
    const credits = player.rec.credits;
    const sold = await cmd(ada, { k: 'sellData' });
    expect(sold).toMatchObject({ ok: true });
    expect(player.rec.credits).toBeGreaterThan(credits);
    expect(await cmd(ada, { k: 'sellData' })).toMatchObject({ ok: false });
  });
});

describe('missions', () => {
  it('offers jobs, takes a deposit for cargo and pays on completion', async () => {
    const player = A.world.players.get(ada.id)!;
    player.rec.credits = 50_000;
    expect(await cmd(ada, { k: 'station' })).toMatchObject({ ok: true });
    await c.settle(() => (ada.station?.missions.length ?? 0) > 0, 'mission offers');
    const offers = ada.station!.missions;
    expect(offers.length).toBeGreaterThanOrEqual(2);
    expect(await cmd(ada, { k: 'missionAccept', id: 'no/such/mission' })).toMatchObject({ ok: false });

    for (const offer of offers) {
      const before = player.rec.credits;
      const accepted = await cmd(ada, { k: 'missionAccept', id: offer.id });
      expect(accepted.err ?? '', offer.title).toBe('');
      expect(await cmd(ada, { k: 'missionAccept', id: offer.id })).toMatchObject({ ok: false });
      if (offer.kind === 'delivery') {
        // Cargo was loaded against a deposit.
        expect(player.cargoCount(offer.c!)).toBeGreaterThanOrEqual(offer.n!);
        expect(player.rec.credits).toBeLessThan(before);
        // It cannot be completed at the wrong station.
        expect(await cmd(ada, { k: 'missionComplete', id: offer.id })).toMatchObject({ ok: false });
        expect(await cmd(ada, { k: 'missionAbandon', id: offer.id })).toMatchObject({ ok: true });
        player.removeCargo(offer.c!, offer.n!);
      } else if (offer.kind === 'mining') {
        expect(await cmd(ada, { k: 'missionComplete', id: offer.id })).toMatchObject({ ok: false });
        player.addCargo(offer.c!, offer.n!, A.id);
        expect(await cmd(ada, { k: 'missionComplete', id: offer.id })).toMatchObject({ ok: true });
        expect(player.rec.credits).toBe(before + offer.reward);
        expect(player.cargoCount(offer.c!)).toBe(0);
      } else {
        // Bounty and survey jobs need work first.
        expect(await cmd(ada, { k: 'missionComplete', id: offer.id })).toMatchObject({ ok: false });
        expect(await cmd(ada, { k: 'missionAbandon', id: offer.id })).toMatchObject({ ok: true });
      }
      // A finished or abandoned offer cannot be taken again.
      expect(await cmd(ada, { k: 'missionAccept', id: offer.id })).toMatchObject({ ok: false });
    }
    await c.run(2);
    expect(ada.pilot!.missions).toHaveLength(0);
  });
});

describe('mining', () => {
  it('cuts ore out of an asteroid, depletes it and releases canisters', async () => {
    const def = [...A.world.defs.values()].find((d) => d.sites.some((s) => s.kind === 'belt'))!;
    expect(def, 'a system with a belt site').toBeDefined();
    const site = def.sites.find((s) => s.kind === 'belt')!;
    const sim = A.world.sim(def.id);
    const rocks = sim.asteroids(site.id);
    expect(rocks.length).toBeGreaterThan(50);
    const idx = rocks.findIndex((r) => r.radius > 40);
    const rock = rocks[idx]!;

    const loadout = starterLoadout('delver');
    const stats = computeShipStats(loadout);
    const state = newShipState(stats);
    state.anchor = site.id;
    // Park 150 m off the surface, nose toward the rock.
    const dir = v3.normalize(rock.pos.some((x) => x !== 0) ? rock.pos : [1, 0, 0]);
    state.pos = v3.addScaled(rock.pos, dir, rock.radius + 150);
    state.rot = quat.lookRotation(v3.neg(dir));
    const miner = newShip(A.world.allocId(), 'Test Miner', loadout, stats, state);
    miner.input.buttons = Button.Fire3;
    sim.addShip(miner);

    await c.run(300);
    const left = sim.asteroidLeft.get(site.id)!;
    expect(left[idx]).toBeLessThan(1);
    expect(left.filter((x) => x < 1)).toHaveLength(1);
    const pods = [...sim.objects.values()].filter((o) => o.kind === EntityKind.Loot);
    expect(pods.length).toBeGreaterThan(0);
    expect(pods.every((o) => o.info.c === rock.ore)).toBe(true);
    expect(miner.state.heat).toBeGreaterThan(0);

    // Not pointing at the rock: nothing is cut.
    const mark = left[idx]!;
    miner.state.rot = quat.lookRotation(dir);
    await c.run(60);
    expect(sim.asteroidLeft.get(site.id)![idx]).toBe(mark);
    sim.removeShip(miner);
  });
});

describe('warp gates', () => {
  it('is proposed by one server and accepted by the other', async () => {
    await c.until(() => gateProjects(A.world).length === 1 && gateProjects(B.world).length === 1, 'gate projects on both sides', 400);
    await c.settle(() => gateProjects(A.world)[0]!.state === 'building', 'proposal answered');
    const a = gateProjects(A.world)[0]!;
    const b = gateProjects(B.world)[0]!;
    expect(a.linkId).toBe(b.linkId);
    expect(a.system).toBe(`${A.id}:0`);
    expect(a.remoteSystem).toBe(b.system);
    expect(b.remoteSystem).toBe(a.system);
    expect(b.state).toBe('building');
    const site = A.world.defs.get(a.system)!.sites.find((s) => s.id === a.site)!;
    expect(site.kind).toBe('gate');
    expect(site.gate?.state).toBe('building');
    // The gate is advertised, and the descriptor is still valid.
    const desc = A.descriptor();
    expect(desc.body.gates).toHaveLength(1);
    expect(verifyDescriptor(desc, c.nowMs).ok).toBe(true);
  });

  it('opens only when both servers have paid for their half', async () => {
    const fund = async (server: PrimacyServer, bot: Bot): Promise<void> => {
      const player = server.world.players.get(bot.id)!;
      const project = gateProjects(server.world)[0]!;
      player.rec.credits = 10_000_000;
      await cmd(bot, { k: 'station' });
      await c.settle(() => (bot.station?.gateProjects.length ?? 0) === 1, 'gate project in station view');
      const view = bot.station!.gateProjects[0]!;
      expect(view.needCredits).toBe(Math.round(GATE_COST.credits * 0.001));
      expect(await cmd(bot, { k: 'gateFund', linkId: project.linkId, c: 'food', n: 1 })).toMatchObject({ ok: false });
      expect(await cmd(bot, { k: 'gateFund', linkId: 'x', credits: 10 })).toMatchObject({ ok: false });
      expect(await cmd(bot, { k: 'gateFund', linkId: project.linkId, credits: 9_999_999 })).toMatchObject({ ok: true });
      // Never more than the gate needs.
      expect(player.rec.credits).toBe(10_000_000 - view.needCredits);
      for (const [commodity, need] of Object.entries(view.needMaterials)) {
        player.rec.passport.ship.cargo.length = 0;
        player.addCargo(commodity, need, server.id);
        expect(await cmd(bot, { k: 'gateFund', linkId: project.linkId, c: commodity, n: need + 5 }), commodity).toMatchObject({ ok: true });
        expect(player.cargoCount(commodity)).toBe(0);
      }
    };

    await fund(A, ada);
    await c.run(160);
    await c.settle(() => gateProjects(B.world)[0]!.remoteProgress === 1, 'B hears that A is done');
    // One finished half is not a gate.
    expect(gateProjects(A.world)[0]!.state).toBe('building');
    expect(gateProjects(B.world)[0]!.state).toBe('building');

    await fund(B, bob);
    await c.until(() => gateProjects(A.world)[0]!.state === 'active' && gateProjects(B.world)[0]!.state === 'active', 'gate open on both sides', 1200);
    expect(await cmd(ada, { k: 'gateFund', linkId: gateProjects(A.world)[0]!.linkId, credits: 10 })).toMatchObject({ ok: false });
  });

  it('carries a pilot who flies through the ring to the far side', async () => {
    const a = gateProjects(A.world)[0]!;
    const b = gateProjects(B.world)[0]!;
    const ship = A.world.players.get(ada.id)!.ship!;
    ship.state.mode = FlightMode.Normal;
    ship.state.anchor = a.site;
    ship.state.pos = [0, 900, 0];
    ship.state.vel = [0, 0, 0];
    await c.run(4);
    expect(ada.handoff).toBeNull();
    ship.state.pos = [20, 10, 0];
    await c.until(() => ada.handoff !== null, 'handoff through the gate', 60);
    c.bots.delete(ada);
    const arrived = c.track(await Bot.connect(ada.handoff!.url, { keys: ada.keys, name: 'Ada', ticket: ada.handoff!.ticket }));
    await c.run(4);
    expect(arrived.serverId).toBe(B.id);
    expect(arrived.system?.id).toBe(b.system);
    expect(arrived.self?.mode).toBe(FlightMode.Normal);
    expect(arrived.self?.anchor).toBe(b.site);
    // Arrival is beside the gate, outside the transit radius, so the pilot is not sent straight back.
    expect(v3.len(arrived.self!.pos)).toBeGreaterThan(1000);
    await c.run(30);
    expect(arrived.handoff).toBeNull();
  });

  it('goes dormant when the far server stops answering', async () => {
    const project = gateProjects(B.world)[0]!;
    await A.stop();
    c.servers.splice(c.servers.indexOf(A), 1);
    c.nowMs += 200_000;
    await c.run(160);
    await c.settle(() => project.state === 'dormant', 'gate dormant');
    expect(B.world.defs.get(project.system)!.sites.find((s) => s.id === project.site)!.gate!.state).toBe('dormant');
  });
});
