/**
 * Review of the landing core on the server, as an attacker and as an unlucky pilot. Every test
 * here states a rule that must hold; the ones marked `it.fails` describe a rule that does not hold
 * yet (the review report says why), and turn red the day it does, so they can be made plain `it`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Button,
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
describe('zz', () => { it('probe los', () => {
  let blocked = 0, total = 0, worst = 0; let ex = '';
  const belly = 3;
  for (let b = 0; b < 360; b += 2) for (let d = 700; d <= 1700; d += 50) for (const h of [2, 10]) {
    const east = Math.cos(b * Math.PI / 180) * d, north = Math.sin(b * Math.PI / 180) * d;
    const p0 = padPoint(east, north, 0);
    const up = upAt(p0);
    const p = v3.scale(up, v3.len(p0) - altitude(p0) + belly + h);
    const target = v3.add(base.ground!.pos, v3.scale(upAt(base.ground!.pos), 10));
    const dir = v3.sub(target, p); const dist = v3.len(dir);
    const hit = groundRay(surface, p, v3.scale(dir, 1 / dist), dist);
    total++; if (hit >= 0) { blocked++; if (!ex) ex = `b${b} d${d} h${h} hit ${hit.toFixed(0)}/${dist.toFixed(0)}`; }
  }
  console.log('PROBE los blocked', blocked, 'of', total, ex);
}); });
