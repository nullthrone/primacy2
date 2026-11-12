/**
 * Wrecks and salvage: a kill leaves a wreck holding the victim's cargo, scrap and parts; a mining
 * laser cuts it open into ordinary cargo pods; nothing is created or lost on the way.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  Button, DT, EntityKind, HULLS, computeShipStats, newPassport, newShipState, packPips, quat, starterLoadout, v3,
  type GameEvent, type SiteDef, type SystemDef, type Vec3,
} from '@primacy2/shared';
import { Player, newShip, type PlayerRecord, type PrimacyServer, type Ship, type SystemSim, type World } from '@primacy2/server';
import { MAX_WRECKS, WRECK_LIFETIME, wreckData } from '../packages/server/src/modules/salvage.ts';
import { Cluster } from './harness.ts';

const c = new Cluster();
let S: PrimacyServer;
let world: World;
let port: { def: SystemDef; site: SiteDef };
let field: { def: SystemDef; site: SiteDef };
let pilots = 0;
const spies = new WeakMap<SystemSim, GameEvent[]>();

function eventsOf(sim: SystemSim): GameEvent[] {
  let evs = spies.get(sim);
  if (!evs) {
    const list: GameEvent[] = (evs = []);
    const emit = sim.emit.bind(sim);
    sim.emit = (zone, ev) => {
      list.push(ev);
      emit(zone, ev);
    };
    spies.set(sim, evs);
  }
  return evs;
}

function run(ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    c.nowMs += DT * 1000;
    S.tick();
  }
}

function place(sim: SystemSim, hull: string, zone: number, pos: Vec3, name = 'Drone'): Ship {
  const loadout = starterLoadout(hull);
  const stats = computeShipStats(loadout);
  const state = newShipState(stats);
  state.anchor = zone;
  state.pos = v3.clone(pos);
  const ship = newShip(world.allocId(), name, loadout, stats, state);
  sim.addShip(ship);
  return ship;
}

/** A pilot parked far away, so the simulation of the system is kept alive. */
function keepAlive(sim: SystemSim, zone: number): void {
  const id = `salvage-pilot-${++pilots}`;
  const rec: PlayerRecord = {
    id, key: id, passport: newPassport(id, id, world.id), credits: 0, status: 'here', system: sim.def.id, ship: null,
    homeSystem: null, homeSite: null, data: {}, createdAt: 0, updatedAt: 0,
  };
  const p = new Player(rec);
  p.conn = { send() {}, sendBinary() {}, close() {} };
  const ship = place(sim, 'wisp', zone, [0, 60_000, 0], id);
  ship.player = p;
  ship.cargo = rec.passport.ship.cargo;
  p.ship = ship;
  p.sim = sim;
}

const OPEN: Vec3 = [20_000, 0, 0];
const wrecksOf = (sim: SystemSim) => [...sim.objects.values()].filter((o) => o.kind === EntityKind.Wreck);
const podsOf = (sim: SystemSim) => [...sim.objects.values()].filter((o) => o.kind === EntityKind.Loot);

/** A ship with a cargo, destroyed in place. Returns the wreck it left. */
function kill(sim: SystemSim, zone: number, pos: Vec3, cargo = [{ c: 'food', n: 7, origin: world.id }, { c: 'alloys', n: 3, origin: 'elsewhere' }], hull = 'drover') {
  const victim = place(sim, hull, zone, pos, 'Hauler');
  victim.cargo = cargo.map((x) => ({ ...x }));
  const before = new Set(wrecksOf(sim).map((o) => o.id));
  sim.destroy(victim, null);
  return wrecksOf(sim).find((o) => !before.has(o.id))!;
}

/** Total tonnes per commodity and origin in a list of stacks. */
function tally(items: { c: string; n: number; origin: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[`${it.c}@${it.origin}`] = (out[`${it.c}@${it.origin}`] ?? 0) + it.n;
  return out;
}

/** Cargo that floated out of the wreck, by commodity and origin as carried by the pods. */
function podTally(sim: SystemSim): Record<string, number> {
  const items: { c: string; n: number; origin: string }[] = [];
  for (const pod of podsOf(sim)) {
    const origins = (pod.data as { origins?: { c: string; n: number; origin: string }[] }).origins!;
    items.push(...origins);
  }
  return tally(items);
}

beforeAll(async () => {
  S = await c.start({ name: 'Salvage', seed: 'salvage' });
  world = S.world;
  // Wandering NPCs would get in the way.
  world.modules.splice(world.modules.findIndex((m) => m.name === 'npc'), 1);
  for (const def of world.defs.values()) {
    for (const site of def.sites) {
      if (!port && (site.kind === 'station' || site.kind === 'outpost')) port = { def, site };
      if (!field && (site.kind === 'belt' || site.kind === 'ring' || site.kind === 'anomaly')) {
        if (world.sim(def.id).asteroids(site.id).length > 0) field = { def, site };
      }
    }
  }
  expect(port).toBeTruthy();
  expect(field).toBeTruthy();
});

afterEach(() => {
  for (const sim of world.sims.values()) {
    for (const ship of [...sim.ships.values()]) sim.removeShip(ship);
    sim.objects.clear();
    spies.get(sim)?.splice(0);
  }
});

afterAll(async () => {
  await c.stop();
});

describe('wrecks', () => {
  it('a kill leaves a wreck with the victim cargo, scrap and the hull identity', () => {
    const sim = world.sim(port.def.id);
    keepAlive(sim, port.site.id);
    const wreck = kill(sim, port.site.id, OPEN);
    expect(wreck.info).toMatchObject({ kind: EntityKind.Wreck, model: 'drover', name: 'Wreck of Hauler', radius: HULLS.drover!.radius });
    expect(wreck.ttl).toBe(WRECK_LIFETIME);
    expect(WRECK_LIFETIME).toBe(15 * 60);
    expect(v3.dist(wreck.pos, OPEN)).toBeLessThan(1);
    const d = wreckData(wreck)!;
    expect(d.fill).toBe(1);
    const held = tally(d.contents);
    expect(held['food@' + world.id]).toBe(7);
    expect(held['alloys@elsewhere']).toBe(3);
    expect(held['scrap@' + world.id]).toBeGreaterThanOrEqual(1);
    expect(d.total).toBe(d.contents.reduce((s, it) => s + it.n, 0));
  });

  it('keeps the velocity of the dead ship and the pilot cargo is emptied into it', () => {
    const sim = world.sim(port.def.id);
    keepAlive(sim, port.site.id);
    const victim = place(sim, 'drover', port.site.id, OPEN);
    victim.state.vel = [0, 0, -40];
    victim.cargo = [{ c: 'food', n: 4, origin: world.id }];
    sim.destroy(victim, null);
    const wreck = wrecksOf(sim)[0]!;
    expect(wreck.vel).toEqual([0, 0, -40]);
    expect(victim.cargo).toHaveLength(0);
    expect(tally(wreckData(wreck)!.contents)['food@' + world.id]).toBe(4);
  });

  it('expires after its lifetime', () => {
    const sim = world.sim(port.def.id);
    keepAlive(sim, port.site.id);
    const wreck = kill(sim, port.site.id, OPEN);
    run(5);
    expect(wreck.ttl).toBeLessThan(WRECK_LIFETIME);
    wreck.ttl = 0.1;
    run(5);
    expect(wrecksOf(sim)).toHaveLength(0);
  });

  it('keeps at most a dozen per zone, dropping the oldest', () => {
    const sim = world.sim(port.def.id);
    keepAlive(sim, port.site.id);
    const made = [];
    for (let i = 0; i < MAX_WRECKS + 3; i++) {
      made.push(kill(sim, port.site.id, [OPEN[0] + i * 400, 0, 0]));
      run(1);
    }
    const left = wrecksOf(sim);
    expect(left).toHaveLength(MAX_WRECKS);
    const ids = new Set(left.map((o) => o.id));
    expect(made.slice(0, 3).some((o) => ids.has(o.id))).toBe(false);
    expect(made.slice(3).every((o) => ids.has(o.id))).toBe(true);
  });
});

describe('salvage', () => {
  it('a mining laser empties a wreck into pods and the wreck disappears, conserving cargo', () => {
    const sim = world.sim(port.def.id);
    keepAlive(sim, port.site.id);
    const evs = eventsOf(sim);
    const wreck = kill(sim, port.site.id, OPEN, undefined, 'wisp');
    const before = tally(wreckData(wreck)!.contents);
    const total = wreckData(wreck)!.total;

    const salvager = place(sim, 'delver', port.site.id, [OPEN[0], 0, 300], 'Salvager');
    salvager.input.buttons = Button.Fire3;
    let ticks = 0;
    let midFill = 1;
    while (wrecksOf(sim).length > 0 && ticks < 8000) {
      run(1);
      ticks++;
      if (wrecksOf(sim).length) midFill = Math.min(midFill, wreckData(wreck)!.fill);
    }
    expect(wrecksOf(sim)).toHaveLength(0);
    expect(midFill).toBeLessThan(1);
    expect(salvager.input.buttons).toBe(Button.Fire3);
    // Everything that went in came out as pods, with its origin.
    expect(podTally(sim)).toEqual(before);
    expect(podsOf(sim).reduce((s, p) => s + (p.info.n ?? 0), 0)).toBe(total);
    // The beam is announced a few times per second, not every tick.
    const beams = evs.filter((e) => e.e === 'salvage');
    expect(beams.length).toBeGreaterThan(0);
    expect(beams.length).toBeLessThan(ticks / 4);
    expect(beams.every((e) => e.e === 'salvage' && e.id === wreck.id && e.from === salvager.id)).toBe(true);
    expect(salvager.state.heat).toBeGreaterThan(0);
  });

  it('does nothing without a mining laser, out of range or off target', () => {
    const sim = world.sim(port.def.id);
    keepAlive(sim, port.site.id);
    const wreck = kill(sim, port.site.id, OPEN);
    const noLaser = place(sim, 'wisp', port.site.id, [OPEN[0], 0, 300], 'Plain');
    noLaser.stats = { ...noLaser.stats, weapons: noLaser.stats.weapons.filter((w) => w.kind !== 'mining') };
    noLaser.input.buttons = Button.Fire3;
    const far = place(sim, 'delver', port.site.id, [OPEN[0] + 5000, 0, 300], 'Far');
    far.input.buttons = Button.Fire3;
    const away = place(sim, 'delver', port.site.id, [OPEN[0] - 5000, 0, 300], 'Away');
    away.input.buttons = Button.Fire3;
    away.state.rot = quat.lookRotation([0, 0, 1]);
    run(90);
    expect(wreckData(wreck)!.fill).toBe(1);
    expect(podsOf(sim)).toHaveLength(0);
  });

  it('draws less energy when the weapons power setting is higher', () => {
    const sim = world.sim(port.def.id);
    keepAlive(sim, port.site.id);
    const drain = (pips: number, z: number): number => {
      kill(sim, port.site.id, [OPEN[0], z, 0]);
      const ship = place(sim, 'delver', port.site.id, [OPEN[0], z, 300], 'Cutter');
      ship.input.buttons = Button.Fire3;
      ship.input.pips = pips;
      const start = ship.state.energy;
      run(20);
      return start - ship.state.energy;
    };
    const low = drain(packPips(4, 8, 0), 0);
    const high = drain(packPips(4, 0, 8), 3000);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThan(low);
  });

  describe('beside asteroids', () => {
    const setup = () => {
      const sim = world.sim(field.def.id);
      keepAlive(sim, field.site.id);
      const rocks = sim.asteroids(field.site.id);
      const idx = rocks.findIndex((r) => r.radius > 40);
      const rock = rocks[idx]!;
      const dir = v3.normalize(rock.pos.some((x) => x !== 0) ? rock.pos : [1, 0, 0]);
      const at = (metresFromSurface: number): Vec3 => v3.addScaled(rock.pos, dir, rock.radius + metresFromSurface);
      const miner = place(sim, 'delver', field.site.id, at(150), 'Miner');
      miner.state.rot = quat.lookRotation(v3.neg(dir));
      return { sim, idx, rock, at, miner, left: () => sim.asteroidLeft.get(field.site.id)?.[idx] ?? 1 };
    };

    it('cuts the wreck when it is nearer than the rock, and leaves the trigger alone', () => {
      const t = setup();
      const wreck = kill(t.sim, field.site.id, t.at(95));
      t.miner.input.buttons = Button.Fire3;
      run(90);
      expect(wreckData(wreck)?.fill ?? 0).toBeLessThan(1);
      expect(t.left()).toBe(1);
      expect(t.miner.input.buttons).toBe(Button.Fire3);
    });

    it('cuts the rock when it is nearer than the wreck', () => {
      const t = setup();
      const wreck = kill(t.sim, field.site.id, v3.addScaled(t.rock.pos, v3.normalize(v3.sub(t.at(0), t.rock.pos)), -(t.rock.radius + 60)));
      t.miner.input.buttons = Button.Fire3;
      run(90);
      expect(t.left()).toBeLessThan(1);
      expect(wreckData(wreck)!.fill).toBe(1);
    });
  });
});
