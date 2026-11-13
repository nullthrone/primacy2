/**
 * Review of the landing core on the server, as an attacker and as an unlucky pilot. Every test
 * here states a rule that must hold; the ones marked `it.fails` describe a rule that does not hold
 * yet (the review report says why), and turn red the day it does, so they can be made plain `it`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Button,
  COMMODITIES,
  DOCK_RANGE,
  DT,
  EntityFlag,
  EntityKind,
  FlightMode,
  G,
  LAND_MAX_SIDE,
  LAND_MAX_SINK,
  MASS_LOCK_RADIUS,
  SCOOP_RANGE,
  absolutePosition,
  anchorFrame,
  anchorState,
  bodySurface,
  computeShipStats,
  groundAltitude,
  groundSiteRotation,
  isLandable,
  findSite,
  isSurfaceAnchor,
  newPassport,
  newShipState,
  quat,
  starterLoadout,
  surfaceAnchor,
  terrainNormal,
  terrainRelief,
  v3,
  type BodyDef,
  type BodySurface,
  type GameEvent,
  type Quat,
  type S2C,
  type SiteDef,
  type SystemDef,
  type Vec3,
} from '@primacy2/shared';
import {
  Player, newShip, type GameModule, type PlayerRecord, type PrimacyServer, type Ship, type SimObject, type SystemSim, type World,
} from '@primacy2/server';
import { BASE_COLLIDER, IMPACT_EPISODE, collideBase, groundRay, impactFraction, padPose } from '../packages/server/src/ground.ts';
import { deductible } from '../packages/server/src/modules/insurance.ts';
import { lawOf } from '../packages/server/src/modules/combat/law.ts';
import { MAX_WRECKS } from '../packages/server/src/modules/salvage.ts';
import { spawnNpc } from '../packages/server/src/modules/npc.ts';
import { wreckData } from '../packages/server/src/modules/salvage.ts';
import { Bot } from './bot.ts';
import { Cluster } from './harness.ts';

const c = new Cluster();
let S: PrimacyServer;
let world: World;
let def: SystemDef;
let sim: SystemSim;
let base: SiteDef;
let body: BodyDef;
let surface: BodySurface;
/** Anchor id of the surface frame of the body the base stands on. */
let zone = -1;
/** Turns the base's own axes (+X east, +Y up, -Z north) into the axes of the surface frame. */
let padRot: Quat;
/** Surface gravity of the body, m/s^2. */
let gravity = 0;
let pilots = 0;

/** Advances the server synchronously; ships keep the input they hold. */
function run(ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    c.nowMs += DT * 1000;
    S.tick();
  }
}

/** Runs until `pred` holds, at most `seconds` of simulated time. Returns whether it did. */
function runUntil(pred: () => boolean, seconds: number): boolean {
  for (let i = 0; i < seconds / DT; i++) {
    if (pred()) return true;
    run(1);
  }
  return pred();
}

/** A point given from the centre of the pad: metres east, north and up, in the surface frame. */
const padPoint = (east: number, north: number, up: number): Vec3 => v3.add(base.ground!.pos, quat.rotate(padRot, [east, up, -north]));
/** Height of a point above the ground beneath it, metres. */
const altitude = (pos: Readonly<Vec3>): number => groundAltitude(surface, pos);
/** Unit vector straight up at a point of the surface frame. */
const upAt = (pos: Readonly<Vec3>): Vec3 => v3.normalize(pos);

interface TestPilot {
  ship: Ship;
  p: Player;
  notices: Extract<S2C, { t: 'notice' }>[];
  events: GameEvent[];
}

/**
 * A pilot with a record and a recording connection but no socket, flying a stock hull in the
 * surface frame at `pos`, at rest, level on the pad's up direction.
 */
function pilot(pos: Vec3, hull = 'wisp', credits = 0): TestPilot {
  const id = `lander-${++pilots}`;
  const passport = newPassport(id, `Lander ${pilots}`, world.id);
  passport.ship.loadout = starterLoadout(hull);
  const rec: PlayerRecord = {
    id, key: id, passport, credits, status: 'here', system: def.id, ship: null,
    homeSystem: null, homeSite: null, data: {}, createdAt: 0, updatedAt: 0,
  };
  const p = new Player(rec);
  const notices: TestPilot['notices'] = [];
  const events: GameEvent[] = [];
  p.conn = {
    send(text) {
      const m = JSON.parse(text) as S2C;
      if (m.t === 'notice') notices.push(m);
      if (m.t === 'ev') events.push(...m.e);
    },
    sendBinary() {},
    close() {},
  };
  const state = newShipState(p.stats);
  state.anchor = zone;
  state.pos = v3.clone(pos);
  state.rot = quat.clone(padRot);
  const ship = newShip(world.allocId(), p.name, passport.ship.loadout, p.stats, state);
  ship.player = p;
  ship.cargo = passport.ship.cargo;
  p.ship = ship;
  p.sim = sim;
  sim.addShip(ship);
  world.players.set(id, p);
  return { ship, p, notices, events };
}

/** A ship without a pilot (not NPC traffic either), hovering at `pos` with its nose along `rot`. */
function drone(pos: Vec3, rot: Quat, hull = 'wisp'): Ship {
  const loadout = starterLoadout(hull);
  const stats = computeShipStats(loadout);
  const state = newShipState(stats);
  state.anchor = zone;
  state.pos = v3.clone(pos);
  state.rot = quat.clone(rot);
  const ship = newShip(world.allocId(), 'Drone', loadout, stats, state);
  sim.addShip(ship);
  return ship;
}

/** Sets a ship down by hand: standing on the ground under `pos`, upright on the ground normal. */
function standAt(ship: Ship, pos: Readonly<Vec3>): void {
  const up = upAt(pos);
  const r = v3.len(pos) - altitude(pos) + ship.stats.belly;
  const n: Vec3 = [0, 0, 0];
  terrainNormal(surface.terrain, up[0], up[1], up[2], 20, n);
  // Any heading will do: something along the ground.
  const along = v3.normalize(v3.cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  ship.state.anchor = zone;
  ship.state.pos = v3.scale(up, r);
  ship.state.vel = [0, 0, 0];
  ship.state.angVel = [0, 0, 0];
  ship.state.rot = quat.lookRotation(along, n);
  ship.state.mode = FlightMode.Landed;
}

/** A spot on natural ground `km` kilometres from the pad that slopes less than five degrees. */
function levelSpot(km: number): Vec3 {
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < 400; i++) {
    const bearing = i * 0.61;
    const p = padPoint(Math.cos(bearing) * km * 1000 + i * 37, Math.sin(bearing) * km * 1000, 0);
    const up = upAt(p);
    if (terrainNormal(surface.terrain, up[0], up[1], up[2], 40, n) < Math.tan((5 * Math.PI) / 180)) {
      return v3.scale(up, v3.len(p) - altitude(p));
    }
  }
  throw new Error('no level ground found');
}

/** Records every damage the simulation applies from now on. */
function watchDamage(): { ship: Ship; amount: number; shield: number }[] {
  const list: { ship: Ship; amount: number; shield: number }[] = [];
  const damage = sim.damage.bind(sim);
  sim.damage = (ship, amount, opts) => {
    list.push({ ship, amount, shield: ship.state.shield });
    damage(ship, amount, opts);
  };
  return list;
}

/** Records every event the simulation emits from now on, with its zone. */
function watchEvents(): { zone: number; ev: GameEvent }[] {
  const list: { zone: number; ev: GameEvent }[] = [];
  const emit = sim.emit.bind(sim);
  sim.emit = (z, ev) => {
    list.push({ zone: z, ev });
    emit(z, ev);
  };
  return list;
}

const objectsOf = (kind: number): SimObject[] => [...sim.objects.values()].filter((o) => o.kind === kind && o.anchor === zone);
/** Rotation from the axes of the surface frame to system axes at the simulation's time. */
const toSystemAxes = (): Quat => anchorFrame(def, zone, sim.time).rot;
/** Another system of the sector that a stock Wisp can reach in one jump. */
function reachableSystem(): string {
  const range = computeShipStats(starterLoadout('wisp')).jumpRange;
  const other = [...world.defs.values()].find((d) => d.id !== def.id && v3.dist(d.pos, def.pos) < range * 0.9);
  if (!other) throw new Error('no system within jump range of the capital');
  return other.id;
}
const cmd = (t: TestPilot, command: Parameters<World['handleCommand']>[1]) =>
  world.handleCommand(t.p, command) as Promise<{ ok: boolean; err?: string; data?: unknown }>;

beforeAll(async () => {
  S = await c.start({ name: 'Landing' });
  world = S.world;
  def = world.defs.get(`${world.id}:0`)!;
  const found = def.sites.find((s) => s.kind === 'base');
  // The identity of a test server is fixed, so its capital always has this base.
  expect(found, 'the capital of the test sector has a ground base').toBeTruthy();
  base = found!;
  body = def.bodies[base.ground!.body]!;
  surface = bodySurface(def, body.id)!;
  zone = surfaceAnchor(body.id);
  padRot = groundSiteRotation(base);
  gravity = (G * body.mass) / (body.radius * body.radius);
  sim = world.sim(def.id);
  // A pilot high above the pad keeps the simulation of the system running.
  pilot(padPoint(0, 0, 30_000));
  run(1);
});

afterAll(async () => {
  await c.stop();

});

/** Natural ground (outside every pad) at `km` from the pad where the slope over 40 m is under five degrees; `bearing0` picks another spot. */
function groundSpot(km: number, bearing0 = 0): Vec3 {
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < 400; i++) {
    const bearing = bearing0 + i * 0.61;
    const p = padPoint(Math.cos(bearing) * km * 1000 + i * 37, Math.sin(bearing) * km * 1000, 0);
    const up = upAt(p);
    if (terrainNormal(surface.terrain, up[0], up[1], up[2], 40, n) < Math.tan((5 * Math.PI) / 180)) {
      return v3.scale(up, v3.len(p) - altitude(p));
    }
  }
  throw new Error('no level ground found');
}

/** Level ground at `km` from the pad, a hovering stock ship's up axis there, and a heading along the ground. */
function slamSetup(km: number, bearing = 0): { up: Vec3; spot: Vec3; rot: Quat } {
  const spot = groundSpot(km, bearing);
  const up = upAt(spot);
  return { up, spot, rot: quat.lookRotation(v3.normalize(v3.cross(up, [1, 0, 0])), up) };
}

describe('hard landings: the second look', () => {
  it('equal slams half a second apart are each paid for, not once for the lot', () => {
    // The impact episode used to be pushed forward by every hard contact and to charge only what
    // exceeds the strongest contact so far, so a ship that kept slamming into the ground at the
    // same speed lost hull for the first slam only.
    const { up, spot, rot } = slamSetup(30);
    const ship = drone(v3.scale(up, v3.len(spot) + 5), rot);
    run(1);
    const lost: number[] = [];
    for (let k = 0; k < 4; k++) {
      Object.assign(ship.state, { mode: FlightMode.Normal, pos: v3.scale(up, v3.len(spot) + ship.stats.belly + 0.2), vel: v3.scale(up, -14), rot: [...rot] });
      const before = ship.state.hull;
      run(15);
      lost.push((before - ship.state.hull) / ship.stats.hullMax);
    }
    expect(lost[0]).toBeGreaterThan(0.1);
    // Later slams are charged at a discount while the memory of the first one lasts, but they cost.
    for (let k = 1; k < 4; k++) expect(lost[k], `slam ${k}`).toBeGreaterThan(0.3 * lost[0]!);
  });

  it('an impact is still charged once while the ship scrapes along: one episode, however many ticks', () => {
    const { up, spot, rot } = slamSetup(31, 1);
    const ship = drone(v3.scale(up, v3.len(spot) + 5), rot);
    run(1);
    const along = v3.normalize(v3.cross(up, [1, 0, 0]));
    Object.assign(ship.state, { mode: FlightMode.Normal, pos: v3.scale(up, v3.len(spot) + ship.stats.belly - 0.5), vel: v3.add(v3.scale(up, -2), v3.scale(along, 22)), rot: [...rot] });
    const before = ship.state.hull;
    run(45);
    const share = (before - ship.state.hull) / ship.stats.hullMax;
    expect(share).toBeGreaterThan(0.15);
    // The slide gives 14 m/s over the sideways limit at the first contact and less after that.
    const wisp = computeShipStats(starterLoadout('wisp'));
    expect(share).toBeLessThan(1.5 * impactFraction(wisp, 22 - 8));
  });
});


describe('events and who hears them', () => {
  it('a hit on the far side of the moon is not told to a pilot hundreds of kilometres away', () => {
    // Events of a surface zone used to go to everyone in the zone, and the zone is the whole shell
    // around the body: a hit carries the id and the position of the ship, so a silent ship was
    // given away to a pilot who could not have picked it up with any sensor.
    const watcher = pilot(padPoint(0, 0, 150));
    const farSpot = groundSpot(700);
    const victim = drone(v3.scale(upAt(farSpot), v3.len(farSpot) + 100), padRot);
    const nearby = drone(padPoint(2_000, 0, 150), padRot);
    run(1);
    watcher.events.length = 0;
    sim.damage(victim, 1);
    sim.damage(nearby, 1);
    run(6);
    expect(watcher.events.some((e) => e.e === 'hit' && e.id === nearby.id), 'a hit 2 km away is still told').toBe(true);
    expect(watcher.events.some((e) => e.e === 'hit' && e.id === victim.id), 'a hit 700 km away is not').toBe(false);
    sim.removeShip(victim);
    sim.removeShip(nearby);
    sim.removeShip(watcher.ship);
    world.players.delete(watcher.p.id);
  });
});

describe('saved states, the second look', () => {
  async function relog(bot: Bot, mutate: (s: Ship['state']) => void): Promise<Bot> {
    mutate(world.players.get(bot.id)!.ship!.state);
    bot.close();
    await c.settle(() => !world.players.has(bot.id), 'the pilot to be logged out');
    c.bots.delete(bot);
    const again = c.track(await Bot.connect(S.url, { keys: bot.keys, name: bot.name }));
    await c.run(4);
    return again;
  }
  const shipOf = (bot: Bot): Ship => world.players.get(bot.id)!.ship!;

  it('a ship saved standing below or above the ground is not put back there', async () => {
    // The terrain can change under a saved ship (a new base adds a pad, a generator fix moves a
    // hill), and a landed ship never looks at the terrain again: one saved under the ground would
    // stay under it for good, and one saved above it would hang in the air.
    let bot = c.track(await Bot.connect(S.url, { name: 'Sunk' }));
    for (const dh of [-80, -3, 60]) {
      const spot = groundSpot(40 + dh * 0.1);
      bot = await relog(bot, (st) => {
        const up = upAt(spot);
        const stats = shipOf(bot).stats;
        Object.assign(st, { mode: FlightMode.Landed, anchor: zone, pos: v3.scale(up, v3.len(spot) + stats.belly + dh), vel: [0, 0, 0] });
        st.rot = quat.lookRotation(v3.normalize(v3.cross(up, [1, 0, 0])), up);
      });
      const ship = shipOf(bot);
      const st = ship.state;
      expect(isSurfaceAnchor(st.anchor), `dh ${dh}: still in the surface frame`).toBe(true);
      expect(altitude(st.pos), `dh ${dh}: not below the ground`).toBeGreaterThanOrEqual(ship.stats.belly - 0.01);
      if (st.mode === FlightMode.Landed) expect(altitude(st.pos), `dh ${dh}: landed means on the ground`).toBeLessThan(ship.stats.belly + 0.5);
    }
    bot.close();
    await c.settle(() => !world.players.has(bot.id), 'the pilot to be logged out');
    c.bots.delete(bot);
  });

  it('a ship flying in the frame of a ground base is not put back there', async () => {
    // A ground site is the anchor of a docked ship only; nothing can fly in its frame.
    let bot = c.track(await Bot.connect(S.url, { name: 'Pad frame' }));
    bot = await relog(bot, (st) => Object.assign(st, { mode: FlightMode.Normal, anchor: base.id, pos: [0, 500, 0], vel: [0, 0, 0] }));
    const st = shipOf(bot).state;
    expect(st.mode === FlightMode.Docked || findSite(def, st.anchor)?.ground === undefined).toBe(true);
    bot.close();
    await c.settle(() => !world.players.has(bot.id), 'the pilot to be logged out');
    c.bots.delete(bot);
  });
});
describe('docking at a base, the second look', () => {
  /** Where the ship's origin is when it hovers `h` metres above the ground at (east, north) from the pad centre. */
  function hoverPoint(east: number, north: number, h: number, belly: number): Vec3 {
    const p0 = padPoint(east, north, 0);
    return v3.scale(upAt(p0), v3.len(p0) - altitude(p0) + belly + h);
  }
  /** The first spot 700 to 1700 m from the pad, 2 m over the ground, with natural terrain between it and the base. */
  function findHiddenSpot(belly: number): { east: number; north: number } | null {
    const top = v3.add(base.ground!.pos, v3.scale(upAt(base.ground!.pos), 60));
    for (let d = 1700; d >= 700; d -= 50) {
      for (let b = 0; b < 360; b += 2) {
        const east = Math.cos((b * Math.PI) / 180) * d;
        const north = Math.sin((b * Math.PI) / 180) * d;
        const p = hoverPoint(east, north, 2, belly);
        const dir = v3.sub(top, p);
        const dist = v3.len(dir);
        if (groundRay(surface, p, v3.scale(dir, 1 / dist), dist) >= 0) return { east, north };
      }
    }
    return null;
  }

  it('a ship behind a hill cannot dock through it; the same distance in the open can', async () => {
    const t = pilot(padPoint(0, 0, 500), 'wisp', 1_000);
    const hidden = findHiddenSpot(t.ship.stats.belly);
    expect(hidden, 'some approach to the base is hidden behind the terrain').not.toBeNull();
    t.ship.state.pos = hoverPoint(hidden!.east, hidden!.north, 2, t.ship.stats.belly);
    t.ship.state.vel = [0, 0, 0];
    expect(Math.hypot(hidden!.east, hidden!.north)).toBeLessThan((base.radius ?? 300) + DOCK_RANGE);
    expect(await cmd(t, { k: 'dock' })).toMatchObject({ ok: false });
    expect(t.ship.state.mode).toBe(FlightMode.Normal);
    // The same distance straight above the pad: nothing in the way.
    t.ship.state.pos = padPoint(0, 0, Math.hypot(hidden!.east, hidden!.north));
    expect(await cmd(t, { k: 'dock' })).toMatchObject({ ok: true });
    expect(await cmd(t, { k: 'undock' })).toMatchObject({ ok: true });
    sim.removeShip(t.ship);
    world.players.delete(t.p.id);
  });

  it('a ship at another landable body cannot dock at this base, whatever the distance in space', async () => {
    const other = def.bodies.find((b) => b.id !== body.id && isLandable(b))!;
    const t = pilot(padPoint(0, 0, 500), 'wisp', 1_000);
    t.ship.state.anchor = surfaceAnchor(other.id);
    t.ship.state.pos = [0, other.radius + 5_000, 0];
    expect(await cmd(t, { k: 'dock' })).toMatchObject({ ok: false, err: 'No base here.' });
    sim.removeShip(t.ship);
    world.players.delete(t.p.id);
  });

  it('a pad full of landed ships blocks neither docking nor undocking, and no time of day puts the ship under the ground', async () => {
    const parked: Ship[] = [];
    for (let k = 0; k < 8; k++) {
      const s = drone(padPoint(0, 0, 20), padRot, 'drover');
      standAt(s, padPoint(-300 + 70 * k, 20 * k - 60, 0));
      parked.push(s);
    }
    const t = pilot(padPoint(120, 0, 200), 'wisp', 1_000);
    for (let day = 0; day < 6; day++) {
      expect(await cmd(t, { k: 'dock' })).toMatchObject({ ok: true });
      expect(await cmd(t, { k: 'undock' })).toMatchObject({ ok: true });
      expect(altitude(t.ship.state.pos), `undocked at hour ${day * 4}`).toBeGreaterThan(300);
      expect(collideBase(padPose(base), t.ship.state.pos, t.ship.stats.radius)).toBeNull();
      // The moon turns; the pilot is back at the pad and docks again, and so on round the clock.
      t.ship.state.pos = padPoint(150, 0, 100);
      t.ship.state.vel = [0, 0, 0];
      c.nowMs += 4 * 3600 * 1000;
      run(60);
    }
    // Nobody was hurt by the crowd: the landed ships stand where they stood.
    for (const s of parked) {
      expect(s.state.mode).toBe(FlightMode.Landed);
      expect(s.state.hull).toBe(s.stats.hullMax);
    }
    for (const s of parked) sim.removeShip(s);
    sim.removeShip(t.ship);
    world.players.delete(t.p.id);
  });
});

/**
 * Crashes a pilot's ship into level ground: 3 m up, 90 m/s down (fast enough to be wrecked even by
 * the steep face of a small crater that a spot of gentle average slope can have). Returns once it is dead.
 */
function crash(t: TestPilot, where: Vec3): void {
  const up = upAt(where);
  t.ship.state.mode = FlightMode.Normal;
  t.ship.state.anchor = zone;
  t.ship.state.pos = v3.scale(up, v3.len(where) + t.ship.stats.belly + 3);
  t.ship.state.vel = v3.scale(up, -90);
  t.ship.input.buttons = Button.FaOff;
  const dead = runUntil(() => t.ship.state.mode === FlightMode.Dead, 3);
  expect(dead, 'the crash destroys the ship').toBe(true);
}
const wrecksHere = (): SimObject[] => objectsOf(EntityKind.Wreck);

describe('crashing on purpose', () => {
  it('pays the deductible, leaves the cargo in the wreck once, and the scrap and parts are worth less than the deductible', async () => {
    const t = pilot(padPoint(0, 0, 100), 'drover', 200_000);
    t.p.addCargo('textiles', 7, world.id, false);
    t.p.addCargo('food', 4, 'elsewhere', false);
    const tonnes = 11;
    const credits = t.p.rec.credits;
    crash(t, groundSpot(25));
    expect(t.p.rec.passport.ship.cargo, 'nothing stays aboard').toHaveLength(0);
    expect(t.ship.cargo).toHaveLength(0);
    const wreck = wrecksHere().find((o) => o.info.name === `Wreck of ${t.ship.name}`)!;
    const contents = wreckData(wreck)!.contents;
    // The goods went into the wreck exactly once: no more, no fewer tonnes.
    expect(contents.filter((x) => x.c === 'textiles' || x.c === 'food').reduce((n, x) => n + x.n, 0)).toBe(tonnes);
    // Whatever scrap and parts the wreck holds on top is worth less than the deductible.
    let salvage = 0;
    for (const it of contents) if (it.c !== 'textiles' && it.c !== 'food') salvage += it.n * (COMMODITIES[it.c]?.price ?? 0);
    const cost = deductible(t.p.rec.passport.ship.loadout, world.config.insuranceRate);
    expect(cost).toBeGreaterThan(0);
    expect(salvage).toBeLessThan(cost);
    // Insurance charges the deductible once, and saving does not bring the cargo back.
    expect(await cmd(t, { k: 'respawn' })).toMatchObject({ ok: true });
    expect(t.p.rec.credits).toBe(credits - cost);
    world.save(t.p);
    expect(t.p.rec.passport.ship.cargo).toHaveLength(0);
    sim.removeShip(t.p.ship!);
    world.players.delete(t.p.id);
  });

  it('a ship destroyed twice in one breath leaves one wreck and costs one deductible', async () => {
    const t = pilot(padPoint(0, 0, 100), 'delver', 200_000);
    t.p.addCargo('textiles', 5, world.id, false);
    const before = wrecksHere().length;
    crash(t, groundSpot(26));
    sim.destroy(t.ship, null);
    sim.damage(t.ship, 1e6);
    run(5);
    expect(wrecksHere().length - before).toBe(1);
    const credits = t.p.rec.credits;
    expect(await cmd(t, { k: 'respawn' })).toMatchObject({ ok: true });
    expect(await cmd(t, { k: 'respawn' })).toMatchObject({ ok: false });
    expect(credits - t.p.rec.credits).toBe(deductible(t.p.rec.passport.ship.loadout, world.config.insuranceRate));
    sim.removeShip(t.p.ship!);
    world.players.delete(t.p.id);
  });

  it('the wrecks of free starter ships cannot push the wreck of a loaded ship out of the zone', () => {
    // A zone keeps a dozen wrecks. Over the whole shell of a moon a free starter ship can be crashed
    // anywhere, so twelve crashes would wipe out whatever a loaded ship had left on the ground.
    const victim = pilot(padPoint(0, 0, 100), 'drover', 0);
    victim.p.addCargo('textiles', 9, world.id, false);
    crash(victim, groundSpot(27));
    const mine = wrecksHere().find((o) => o.info.name === `Wreck of ${victim.ship.name}`)!;
    expect(mine).toBeTruthy();
    for (let k = 0; k < MAX_WRECKS + 2; k++) {
      const fodder = pilot(padPoint(0, 0, 100), 'wisp', 0);
      crash(fodder, groundSpot(28 + k));
      sim.removeShip(fodder.ship);
      world.players.delete(fodder.p.id);
    }
    expect(wrecksHere().length).toBeLessThanOrEqual(MAX_WRECKS);
    expect(wrecksHere().some((o) => o.id === mine.id), 'the loaded wreck is still there').toBe(true);
  });

  it('a wanted pilot under fire cannot crash on purpose to keep the bounty from the hunter', async () => {
    const hunter = pilot(padPoint(0, 0, 400), 'lancet', 0);
    const quarry = pilot(padPoint(0, 0, 100), 'wisp', 0);
    const law = lawOf(quarry.p);
    law.bounty = 5_000;
    law.wantedUntil = sim.time + 600;
    quarry.ship.wanted = true;
    // The hunter has just hit the quarry; the quarry flies into the ground.
    sim.damage(quarry.ship, 1, { by: hunter.ship });
    run(10);
    const before = hunter.p.rec.credits;
    const kills = hunter.p.rec.passport.stats.kills;
    crash(quarry, groundSpot(45));
    expect(hunter.p.rec.credits, 'the bounty goes to the hunter').toBe(before + 5_000);
    expect(hunter.p.rec.passport.stats.kills).toBe(kills + 1);
    for (const x of [hunter, quarry]) {
      sim.removeShip(x.ship);
      world.players.delete(x.p.id);
    }
  });
});
