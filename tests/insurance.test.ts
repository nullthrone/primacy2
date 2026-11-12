/**
 * Insurance: a destroyed pilot gets the same ship back for a deductible, or the free starter ship
 * when they cannot pay. The cargo stays in the wreck.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DT, EntityKind, FlightMode, HULLS, MODULES, computeShipStats, newPassport, newShipState, starterLoadout, v3,
  type Loadout, type S2C, type SiteDef, type SystemDef, type Vec3,
} from '@primacy2/shared';
import { Player, newShip, type PlayerRecord, type PrimacyServer, type Ship, type SystemSim, type World } from '@primacy2/server';
import { deductible } from '../packages/server/src/modules/insurance.ts';
import { Cluster } from './harness.ts';

const c = new Cluster();
let S: PrimacyServer;
let world: World;
let port: { def: SystemDef; site: SiteDef };
let pilots = 0;

const OPEN: Vec3 = [20_000, 0, 0];

function run(ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    c.nowMs += DT * 1000;
    S.tick();
  }
}

interface TestPilot {
  ship: Ship;
  p: Player;
  notices: Extract<S2C, { t: 'notice' }>[];
}

/** Places a ship flown by a pilot who has a record and a recording connection but no socket. */
function pilot(sim: SystemSim, loadout: Loadout, pos: Vec3, credits: number): TestPilot {
  const id = `insured-${++pilots}`;
  const passport = newPassport(id, `Insured ${pilots}`, world.id);
  passport.ship.loadout = loadout;
  const rec: PlayerRecord = {
    id, key: id, passport, credits, status: 'here', system: sim.def.id, ship: null,
    homeSystem: null, homeSite: null, data: {}, createdAt: 0, updatedAt: 0,
  };
  const p = new Player(rec);
  const notices: TestPilot['notices'] = [];
  p.conn = {
    send(text) {
      const m = JSON.parse(text) as S2C;
      if (m.t === 'notice') notices.push(m);
    },
    sendBinary() {},
    close() {},
  };
  const state = newShipState(p.stats);
  state.anchor = port.site.id;
  state.pos = v3.clone(pos);
  const ship = newShip(world.allocId(), p.name, loadout, p.stats, state);
  ship.player = p;
  ship.cargo = passport.ship.cargo;
  p.ship = ship;
  p.sim = sim;
  sim.addShip(ship);
  world.players.set(id, p);
  return { ship, p, notices };
}

function respawn(t: TestPilot) {
  const mod = world.modules.find((m) => m.name === 'insurance')!;
  return mod.commands!.respawn!(t.p, { k: 'respawn' }, world) as { ok: boolean; err?: string; data?: { charged: number; starter: boolean } };
}

const valueOf = (lo: Loadout): number =>
  HULLS[lo.hull]!.price + lo.modules.reduce((sum, id) => sum + (id ? MODULES[id]!.price : 0), 0);

/** A drover with a pricier fit than stock. */
function richFit(): Loadout {
  const lo = starterLoadout('drover');
  const slot = HULLS.drover!.slots.findIndex((s) => s === 'utility');
  lo.modules[slot] = 'cargo_3';
  return lo;
}

beforeAll(async () => {
  S = await c.start({ name: 'Insurance', seed: 'insurance' });
  world = S.world;
  world.modules.splice(world.modules.findIndex((m) => m.name === 'npc'), 1);
  for (const def of world.defs.values()) {
    for (const site of def.sites) if (!port && (site.kind === 'station' || site.kind === 'outpost')) port = { def, site };
  }
  expect(port).toBeTruthy();
  // A pilot far away keeps the simulation of the system running.
  pilot(world.sim(port.def.id), starterLoadout('wisp'), [0, 60_000, 0], 0);
});

afterEach(() => {
  world.config.insuranceRate = 0.05;
});

afterAll(async () => {
  await c.stop();
});

describe('insurance', () => {
  it('charges the deductible, keeps ship and fit, and leaves the cargo in the wreck', () => {
    const sim = world.sim(port.def.id);
    const loadout = richFit();
    const t = pilot(sim, loadout, OPEN, 5_000_000);
    t.p.addCargo('alloys', 6, 'elsewhere');
    sim.destroy(t.ship, null);
    expect(t.ship.state.mode).toBe(FlightMode.Dead);
    expect(t.p.rec.passport.ship.cargo).toHaveLength(0);
    // No deductible is taken at the kill, and the cargo is in the wreck.
    expect(t.p.rec.credits).toBe(5_000_000);
    const wreck = [...sim.objects.values()].find((o) => o.kind === EntityKind.Wreck && o.info.name === `Wreck of ${t.p.name}`)!;
    expect((wreck.data as { contents: { c: string; n: number; origin: string }[] }).contents)
      .toContainEqual({ c: 'alloys', n: 6, origin: 'elsewhere' });

    const cost = Math.round(valueOf(loadout) * 0.05);
    expect(deductible(loadout, 0.05)).toBe(cost);
    const res = respawn(t);
    expect(res).toMatchObject({ ok: true, data: { charged: cost, starter: false } });
    expect(Number.isInteger(t.p.rec.credits)).toBe(true);
    expect(t.p.rec.credits).toBe(5_000_000 - cost);
    expect(t.p.rec.passport.ship.loadout).toEqual(loadout);
    expect(t.ship.state.mode).toBe(FlightMode.Docked);
    expect(t.ship.state.hull).toBe(t.p.stats.hullMax);
    expect(t.ship.state.fuel).toBe(t.p.stats.fuelCap);
    expect(t.p.cargoCount('alloys')).toBe(0);
    expect(t.notices.some((n) => n.code === 'insurance' && n.text.includes(String(cost)))).toBe(true);
    // A second respawn is refused: the pilot is alive.
    expect(respawn(t).ok).toBe(false);
    run(2);
    sim.removeShip(t.ship);
  });

  it('follows the server rate', () => {
    const sim = world.sim(port.def.id);
    world.config.insuranceRate = 0.2;
    const lo = starterLoadout('wisp');
    const t = pilot(sim, lo, OPEN, 1_000_000);
    sim.destroy(t.ship, null);
    respawn(t);
    expect(t.p.rec.credits).toBe(1_000_000 - Math.round(valueOf(lo) * 0.2));
    sim.removeShip(t.ship);
  });

  it('issues the starter ship to a pilot who cannot pay, and keeps the credits', () => {
    const sim = world.sim(port.def.id);
    const t = pilot(sim, richFit(), OPEN, 1_234);
    sim.destroy(t.ship, null);
    const res = respawn(t);
    expect(res).toMatchObject({ ok: true, data: { charged: 0, starter: true } });
    expect(t.p.rec.credits).toBe(1_234);
    expect(t.p.rec.passport.ship.loadout).toEqual(starterLoadout());
    expect(t.ship.stats.hull).toBe('wisp');
    expect(t.ship.state.mode).toBe(FlightMode.Docked);
    expect(t.notices.some((n) => n.code === 'insurance' && /starter/i.test(n.text))).toBe(true);
    sim.removeShip(t.ship);
  });

  it('shows the current deductible in the pilot view and keeps it current across a refit', () => {
    const sim = world.sim(port.def.id);
    const t = pilot(sim, starterLoadout('drover'), OPEN, 10_000);
    const stock = world.pilotView(t.p).rebuy;
    expect(stock).toBe(Math.round(valueOf(starterLoadout('drover')) * 0.05));

    const slot = HULLS.drover!.slots.findIndex((s) => s === 'utility');
    t.p.rec.passport.ship.loadout.modules[slot] = 'cargo_3';
    t.p.refit();
    const refitted = world.pilotView(t.p).rebuy!;
    expect(refitted).toBe(Math.round(valueOf(t.p.rec.passport.ship.loadout) * 0.05));
    expect(refitted).toBeGreaterThan(stock!);
    // Another hull entirely.
    t.p.rec.passport.ship.loadout = starterLoadout('wisp');
    t.p.stats = computeShipStats(t.p.rec.passport.ship.loadout);
    expect(world.pilotView(t.p).rebuy).toBe(Math.round(valueOf(starterLoadout('wisp')) * 0.05));
    sim.removeShip(t.ship);
  });
});
