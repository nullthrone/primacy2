/**
 * Acceptance test for the federation: real servers, a real protocol client, and the whole
 * journey from a first login to a visit on another server and back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Domain,
  CRUISE_MIN_SPEED,
  FlightMode,
  MASS_LOCK_RADIUS,
  cargoTonnes,
  computeShipStats,
  generateKeyPair,
  idFromPublicKey,
  issueTicket,
  nearestPair,
  newPassport,
  randomNonce,
  signBody,
  v3,
  type Signed,
  type SystemSummary,
  type TransferTicket,
} from '@primacy2/shared';
import type { PrimacyServer } from '@primacy2/server';
import { Bot } from './bot.ts';
import { Cluster } from './harness.ts';

const c = new Cluster();
let A: PrimacyServer;
let B: PrimacyServer;
let bot: Bot;
let usedTicket: Signed<TransferTicket>;
/** System of A and system of B that are closest to each other. */
let border: { a: SystemSummary; b: SystemSummary; dist: number };

const systemsOf = (s: PrimacyServer): SystemSummary[] => s.descriptor().body.systems;

/** Shortest hop sequence between two systems of one server with the given jump range, excluding the start. */
function route(s: PrimacyServer, from: string, to: string, range: number): string[] {
  const all = systemsOf(s);
  const prev = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === to) break;
    const here = all.find((x) => x.id === cur)!;
    for (const n of all) {
      if (!prev.has(n.id) && v3.dist(here.pos, n.pos) <= range) {
        prev.set(n.id, cur);
        queue.push(n.id);
      }
    }
  }
  if (!prev.has(to)) throw new Error(`no route from ${from} to ${to} within ${range} ly`);
  const path: string[] = [];
  for (let at: string | null = to; at && at !== from; at = prev.get(at) ?? null) path.unshift(at);
  return path;
}

/** Test shortcut: fills the tank so a multi-hop route does not depend on station stops. */
function refuel(s: PrimacyServer, b: Bot): void {
  const ship = s.world.players.get(b.id)?.ship;
  if (ship) ship.state.fuel = ship.stats.fuelCap;
}

async function foldTo(s: PrimacyServer, b: Bot, system: string): Promise<void> {
  refuel(s, b);
  const res = await cmd(b, { k: 'fold', system });
  expect(res, `fold to ${system}`).toMatchObject({ ok: true });
  await c.until(() => b.system?.id === system && b.self?.mode === FlightMode.Cruise, `arrival in ${system}`, 900);
}

/** Sends a command and keeps the cluster ticking until the reply arrives. */
async function cmd(b: Bot, command: Parameters<Bot['cmd']>[0]) {
  let reply: Awaited<ReturnType<Bot['cmd']>> | null = null;
  void b.cmd(command).then((r) => (reply = r));
  await c.settle(() => reply !== null, `reply to ${command.k}`);
  return reply!;
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

beforeAll(async () => {
  A = await c.start({ name: 'Alpha', seed: 'alpha' });
  B = await c.start({ name: 'Beta', seed: 'beta', peers: [A.url] });
  await B.peer();
});

afterAll(async () => {
  await c.stop();
});

describe('federation', () => {
  it('peering makes the universe larger and reachable', () => {
    expect(A.fed.links().map((k) => k.id)).toEqual([B.id]);
    expect(B.fed.links().map((k) => k.id)).toEqual([A.id]);
    const galaxy = A.world.galaxyView();
    expect(galaxy.sectors.map((s) => s.id).sort()).toEqual([A.id, B.id].sort());
    expect(galaxy.sectors.reduce((n, s) => n + s.systems.length, 0)).toBe(16);

    const pair = nearestPair(systemsOf(A), systemsOf(B))!;
    border = pair;
    const reach = computeShipStats({ hull: 'wisp', modules: [] }).jumpRange;
    // The new sector sits next to its first peer, close enough for the starter hull.
    expect(pair.dist).toBeLessThanOrEqual(reach * 0.9 + 1e-6);
    expect(pair.dist).toBeGreaterThanOrEqual(reach * 0.5 - 1e-6);
  });

  it('every system of a sector is reachable with the starter hull', () => {
    const reach = computeShipStats({ hull: 'wisp', modules: [] }).jumpRange;
    for (const s of [A, B]) for (const sys of systemsOf(s)) route(s, `${s.id}:0`, sys.id, reach);
  });

  it('a new pilot starts docked at the capital', async () => {
    bot = c.track(await Bot.connect(A.url, { name: 'Ada Lovelace' }));
    await c.run(4);
    expect(bot.serverId).toBe(A.id);
    expect(bot.system?.id).toBe(`${A.id}:0`);
    expect(bot.self?.mode).toBe(FlightMode.Docked);
    expect(bot.pilot?.credits).toBe(A.config.startCredits);
    expect(bot.pilot?.name).toBe('Ada Lovelace');
    expect(bot.station?.name).toBeTruthy();
  });

  it('undocks and flies with flight assist', async () => {
    expect(await cmd(bot, { k: 'undock' })).toMatchObject({ ok: true });
    await c.run(2);
    expect(bot.self?.mode).toBe(FlightMode.Normal);
    const start = v3.clone(bot.self!.pos);
    bot.held.thrust = [0, 0, 1];
    await c.run(240);
    const stats = computeShipStats(bot.pilot!.passport.ship.loadout);
    const speed = v3.len(bot.self!.vel);
    expect(speed).toBeGreaterThan(stats.maxSpeed * 0.9);
    expect(speed).toBeLessThan(stats.maxSpeed * 1.03);
    expect(v3.dist(bot.self!.pos, start)).toBeGreaterThan(1000);
    bot.held.thrust = [0, 0, 0];
    // Releasing the keys brakes with the retro thrusters, which are weaker than the main engine.
    await c.run(Math.ceil((stats.maxSpeed / stats.accelBack + 2) * 30));
    expect(v3.len(bot.self!.vel)).toBeLessThan(2);
  });

  it('cruise is mass-locked near the station and works further out', async () => {
    if (v3.len(bot.self!.pos) < MASS_LOCK_RADIUS) {
      expect(await cmd(bot, { k: 'cruise', on: true })).toMatchObject({ ok: false });
    }
    bot.held.thrust = [0, 0, 1];
    await c.until(() => v3.len(bot.self!.pos) > MASS_LOCK_RADIUS + 300, 'leaving the mass lock', 1500);
    bot.held.thrust = [0, 0, 0];
    expect(await cmd(bot, { k: 'cruise', on: true })).toMatchObject({ ok: true });
    await c.until(() => bot.self?.mode === FlightMode.Cruise, 'cruise engaged', 300);
    bot.held.throttle = 1;
    await c.run(150);
    expect(bot.self!.cruiseSpeed).toBeGreaterThan(CRUISE_MIN_SPEED * 2);
  });

  it('fold jumps between systems of one server', async () => {
    const reach = computeShipStats(bot.pilot!.passport.ship.loadout).jumpRange;
    const hops = route(A, bot.system!.id, border.a.id, reach);
    for (const hop of hops) await foldTo(A, bot, hop);
    expect(bot.system!.id).toBe(border.a.id);
    // Arrival is in cruise, well clear of the primary.
    const primary = bot.system!.bodies[0]!;
    expect(v3.len(bot.self!.pos)).toBeGreaterThan(primary.radius * 2);
    expect(await cmd(bot, { k: 'fold', system: 'aaaaaaaaaaaaaaaa:0' })).toMatchObject({ ok: false });
  });

  it('a fold jump to another server hands the pilot over', async () => {
    refuel(A, bot);
    expect(await cmd(bot, { k: 'fold', system: border.b.id })).toMatchObject({ ok: true });
    await c.until(() => bot.handoff !== null, 'handoff message', 600);
    const h = bot.handoff!;
    expect(h.server).toBe(B.id);
    expect(h.url).toBe(B.url);
    expect(A.store.loadPlayer(bot.id)?.status).toBe('transit');
    expect(A.world.players.has(bot.id)).toBe(false);
    usedTicket = h.ticket;

    c.bots.delete(bot);
    const arrived = c.track(await Bot.connect(h.url, { keys: bot.keys, name: bot.name, ticket: h.ticket }));
    await c.run(4);
    expect(arrived.serverId).toBe(B.id);
    expect(arrived.system?.id).toBe(border.b.id);
    expect(arrived.self?.mode).toBe(FlightMode.Cruise);
    expect(arrived.pilot?.name).toBe('Ada Lovelace');
    expect(arrived.pilot?.passport.home).toBe(A.id);
    expect(arrived.pilot?.passport.stats.jumps).toBeGreaterThan(0);
    // Credits are local to each server: a visitor starts with none.
    expect(arrived.pilot?.credits).toBe(0);
    expect(A.store.loadPlayer(bot.id)?.status).toBe('away');
    bot = arrived;
  });

  it('rejects replayed, tampered, stolen and misdirected tickets', async () => {
    const replay = await refused(B.url, { keys: bot.keys, ticket: usedTicket });
    expect(replay.authFail).toMatchObject({ code: 'ticket' });
    expect(replay.authFail!.msg).toMatch(/already used/);

    const tampered = structuredClone(usedTicket);
    tampered.body.passport.ship.loadout.hull = 'bulwark';
    expect((await refused(B.url, { keys: bot.keys, ticket: tampered })).authFail).toMatchObject({ code: 'ticket' });

    const thief = generateKeyPair();
    expect((await refused(B.url, { keys: thief, ticket: usedTicket })).authFail).toMatchObject({ code: 'ticket' });

    expect((await refused(A.url, { keys: bot.keys, ticket: usedTicket })).authFail).toMatchObject({ code: 'ticket' });

    // A ticket from a server nobody has heard of, correctly signed by that server.
    const rogue = generateKeyPair();
    const rogueId = idFromPublicKey(rogue.publicKey);
    const stranger = generateKeyPair();
    const forged = issueTicket(
      {
        issuer: rogueId, dest: B.id, playerKey: stranger.publicKey,
        passport: newPassport(idFromPublicKey(stranger.publicKey), 'Mallory', rogueId),
        arrival: { kind: 'fold', system: `${B.id}:0` }, nonce: randomNonce(), nowMs: c.nowMs,
      },
      rogue,
    );
    const res = await refused(B.url, { keys: stranger, ticket: forged });
    expect(res.authFail).toMatchObject({ code: 'ticket' });
    expect(res.authFail!.msg).toMatch(/unknown/);

    // A ticket that claims to come from A but is signed with another key.
    const impostor = signBody(Domain.Ticket, { ...usedTicket.body, nonce: randomNonce() }, rogue);
    expect((await refused(B.url, { keys: bot.keys, ticket: impostor })).authFail).toMatchObject({ code: 'ticket' });

    // None of this disturbed the pilot who is legitimately on B.
    await c.run(2);
    expect(bot.closed).toBe(false);
    expect(B.world.players.has(bot.id)).toBe(true);
  });

  it('the origin server redirects a pilot whose ship is elsewhere', async () => {
    const res = await refused(A.url, { keys: bot.keys });
    expect(res.authFail).toMatchObject({ code: 'elsewhere', redirect: { server: B.id, url: B.url } });
  });

  it('the pilot can travel back', async () => {
    refuel(B, bot);
    expect(await cmd(bot, { k: 'fold', system: border.a.id })).toMatchObject({ ok: true });
    await c.until(() => bot.handoff !== null, 'handoff back', 600);
    const h = bot.handoff!;
    c.bots.delete(bot);
    const home = c.track(await Bot.connect(h.url, { keys: bot.keys, name: bot.name, ticket: h.ticket }));
    await c.run(4);
    expect(home.serverId).toBe(A.id);
    expect(home.system?.id).toBe(border.a.id);
    expect(A.store.loadPlayer(bot.id)?.status).toBe('here');
    // The credits left behind on A are still there.
    expect(home.pilot?.credits).toBe(A.config.startCredits);
    expect(B.store.loadPlayer(bot.id)?.status).toBe('away');
    bot = home;
  });

  it('returning to the origin before the ticket is used voids it', async () => {
    refuel(A, bot);
    expect(await cmd(bot, { k: 'fold', system: border.b.id })).toMatchObject({ ok: true });
    await c.until(() => bot.handoff !== null, 'handoff', 600);
    const ticket = bot.handoff!.ticket;
    c.bots.delete(bot);
    // The pilot changes their mind (or the destination was unreachable) and reconnects to A.
    const back = c.track(await Bot.connect(A.url, { keys: bot.keys, name: bot.name }));
    await c.run(4);
    expect(back.system?.id).toBe(border.a.id);
    expect(A.store.loadPlayer(bot.id)?.status).toBe('here');
    const late = await refused(B.url, { keys: bot.keys, ticket });
    expect(late.authFail).toMatchObject({ code: 'ticket' });
    expect(late.authFail!.msg).toMatch(/did not confirm/);
    bot = back;
  });

  it('gossip spreads sectors beyond direct links', async () => {
    const C = await c.start({ name: 'Gamma', seed: 'gamma', peers: [B.url] });
    await C.peer();
    await B.fed.gossipRound();
    await A.fed.gossipRound();
    const galaxy = A.world.galaxyView();
    expect(galaxy.sectors.map((s) => s.name).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(galaxy.sectors.find((s) => s.id === C.id)?.linked).toBe(false);
    expect(galaxy.sectors.find((s) => s.id === B.id)?.linked).toBe(true);
    // Gamma placed itself next to Beta, its first peer.
    const pair = nearestPair(systemsOf(B), systemsOf(C))!;
    expect(pair.dist).toBeLessThanOrEqual(computeShipStats({ hull: 'wisp', modules: [] }).jumpRange);
  });

  it('a hostile server cannot inject wealth or impossible ships', async () => {
    const M = await c.start({ name: 'Mallory', seed: 'mallory', peers: [A.url] });
    await M.peer();
    const mule = c.track(await Bot.connect(M.url, { name: 'Mule' }));
    await c.run(2);
    const player = M.world.players.get(mule.id)!;
    // Mallory edits its own database: an impossible ship stuffed with the most valuable cargo.
    player.rec.passport.ship.loadout = { hull: 'wisp', modules: ['rail_1', 'rail_1', 'shield_3', 'thruster_3', 'fold_3', 'reactor_3', 'cargo_3', 'made_up_module'] };
    player.rec.passport.ship.cargo.push({ c: 'exotic_matter', n: 1_000_000, origin: M.id }, { c: 'made_up_goods', n: 50, origin: M.id });
    player.rec.passport.ship.hull = 1e9;
    (player.rec.passport as unknown as Record<string, unknown>).credits = 1e12;
    const res = M.world.handoff(player, M.fed.known.get(A.id)!, { kind: 'fold', system: `${A.id}:0` });
    expect(res).toEqual({ ok: true });
    await c.settle(() => mule.handoff !== null, 'handoff from Mallory');
    c.bots.delete(mule);

    const visitor = c.track(await Bot.connect(A.url, { keys: mule.keys, name: 'Mule', ticket: mule.handoff!.ticket }));
    await c.run(2);
    const ship = visitor.pilot!.passport.ship;
    const stats = computeShipStats(ship.loadout);
    expect(visitor.pilot!.credits).toBe(0);
    expect(ship.loadout.modules[7]).toBeNull();
    expect(ship.hull).toBeLessThanOrEqual(stats.hullMax);
    expect(cargoTonnes(ship.cargo)).toBeLessThanOrEqual(stats.cargoCap);
    expect(ship.cargo.every((it) => it.c === 'exotic_matter')).toBe(true);
    // The server-side ship flies with stats derived here, not with anything Mallory sent.
    const live = A.world.players.get(mule.id)!.ship!;
    expect(live.stats).toEqual(stats);
    expect(live.state.hull).toBeLessThanOrEqual(stats.hullMax);

    // An operator can cut a hostile sector off entirely.
    A.config.trust[M.id] = 'blocked';
    const again = M.world.players.get(mule.id);
    expect(again).toBeUndefined();
    const second = c.track(await Bot.connect(M.url, { name: 'Mule Two' }));
    await c.run(2);
    const p2 = M.world.players.get(second.id)!;
    expect(M.world.handoff(p2, M.fed.known.get(A.id)!, { kind: 'fold', system: `${A.id}:0` })).toEqual({ ok: true });
    await c.settle(() => second.handoff !== null, 'second handoff from Mallory');
    c.bots.delete(second);
    const blocked = await refused(A.url, { keys: second.keys, ticket: second.handoff!.ticket });
    expect(blocked.authFail).toMatchObject({ code: 'ticket' });
    expect(blocked.authFail!.msg).toMatch(/blocked/);
  });
});
