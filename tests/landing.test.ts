/**
 * Landing on the server: a real world on a manually advanced clock. Ships are flown by real
 * clients over sockets where the wire matters (touchdown, logout, what two pilots see of each
 * other) and placed directly into the simulation where exact speeds and distances matter.
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

describe('touching down', () => {
  let bot: Bot;
  let ship: Ship;

  it('a pilot who sinks gently lands, and the ship stays where it stands while the moon turns', async () => {
    bot = c.track(await Bot.connect(S.url, { name: 'Lander' }));
    ship = world.players.get(bot.id)!.ship!;
    // From the dock at the station to forty metres over the pad, clear of the base block.
    Object.assign(ship.state, { mode: FlightMode.Normal, anchor: zone, pos: padPoint(220, 0, 40 + ship.stats.belly), vel: [0, 0, 0], rot: quat.clone(padRot) });
    bot.held.thrust = [0, -0.02, 0];
    await c.until(() => bot.self?.mode === FlightMode.Landed, 'the ship to land', 1500);
    bot.held.thrust = [0, 0, 0];
    await c.run(3);

    expect(ship.state.mode).toBe(FlightMode.Landed);
    expect(ship.state.anchor).toBe(zone);
    expect(ship.state.hull).toBe(ship.stats.hullMax);
    expect(altitude(ship.state.pos)).toBeCloseTo(ship.stats.belly, 2);
    expect(v3.len(ship.state.vel)).toBe(0);
    expect(ship.flags & EntityFlag.Landed).toBe(EntityFlag.Landed);
    // The ship is still in the world: it has a heat signature, a quarter of an idle ship's.
    expect(ship.state.sig).toBeGreaterThan(0);

    const pos = [...ship.state.pos];
    const rot = [...ship.state.rot];
    const centre0 = anchorState(def, body.id, sim.time).pos;
    const fromCentre0 = v3.sub(absolutePosition(ship.state, def, sim.time), centre0);
    const toPad0 = v3.dist(absolutePosition(ship.state, def, sim.time), anchorState(def, base.id, sim.time).pos);

    // Ten minutes tick by tick, then five hours at once, then another minute.
    run(600 / DT);
    c.nowMs += 5 * 3600 * 1000;
    run(60 / DT);

    expect(ship.state.mode).toBe(FlightMode.Landed);
    expect(ship.state.pos).toEqual(pos);
    expect(ship.state.rot).toEqual(rot);
    expect(ship.state.hull).toBe(ship.stats.hullMax);
    // In system axes the ground has carried the ship a long way around the body ...
    const fromCentre1 = v3.sub(absolutePosition(ship.state, def, sim.time), anchorState(def, body.id, sim.time).pos);
    expect(v3.dist(fromCentre0, fromCentre1)).toBeGreaterThan(0.5 * body.radius);
    // ... and it is exactly as far from the pad as before.
    const toPad1 = v3.dist(absolutePosition(ship.state, def, sim.time), anchorState(def, base.id, sim.time).pos);
    expect(Math.abs(toPad1 - toPad0)).toBeLessThan(0.01);
    await c.run(4);
    expect(bot.self?.mode).toBe(FlightMode.Landed);
    expect(bot.self?.pos).toEqual(pos);
  });

  it('logging out and in again brings the ship back where it stood', async () => {
    const pos = [...ship.state.pos];
    const rot = [...ship.state.rot];
    bot.close();
    await c.settle(() => !world.players.has(bot.id), 'the pilot to be logged out');
    c.bots.delete(bot);
    const again = c.track(await Bot.connect(S.url, { keys: bot.keys, name: 'Lander' }));
    await c.run(4);
    expect(again.self?.mode).toBe(FlightMode.Landed);
    expect(again.self?.anchor).toBe(zone);
    expect(again.self?.pos).toEqual(pos);
    expect(again.self?.rot).toEqual(rot);
    bot = again;
    ship = world.players.get(bot.id)!.ship!;
  });

  it('thrusting up lifts the ship off again', async () => {
    bot.held.thrust = [0, 1, 0];
    await c.until(() => bot.self?.mode === FlightMode.Normal, 'the ship to lift off', 60);
    await c.run(30);
    bot.held.thrust = [0, 0, 0];
    expect(altitude(ship.state.pos)).toBeGreaterThan(ship.stats.belly + 1);
    expect(ship.flags & EntityFlag.Landed).toBe(0);
    bot.close();
    await c.settle(() => !world.players.has(bot.id), 'the pilot to be logged out');
    c.bots.delete(bot);
  });
});

describe('hard landings', () => {
  it('the rule: a quarter of a Wisp at 10 m/s over the limits, all of it at 25, more for heavy hulls', () => {
    const wisp = computeShipStats(starterLoadout('wisp'));
    expect(impactFraction(wisp, 0)).toBe(0);
    expect(impactFraction(wisp, 10)).toBeCloseTo(0.25, 10);
    expect(impactFraction(wisp, 20)).toBeGreaterThan(0.6);
    expect(impactFraction(wisp, 20)).toBeLessThan(0.8);
    expect(impactFraction(wisp, 24)).toBeLessThan(1);
    expect(impactFraction(wisp, 26)).toBeGreaterThan(1);
    // A freighter carries far more mass per hull point and is wrecked sooner; armour helps.
    const drover = computeShipStats(starterLoadout('drover'));
    const bulwark = computeShipStats(starterLoadout('bulwark'));
    expect(impactFraction(drover, 10) / impactFraction(wisp, 10)).toBeGreaterThan(1.4);
    expect(impactFraction(drover, 10) / impactFraction(wisp, 10)).toBeLessThanOrEqual(1.6);
    expect(impactFraction(bulwark, 10)).toBeGreaterThan(impactFraction(wisp, 10));
    expect(impactFraction(bulwark, 10)).toBeLessThan(impactFraction(drover, 10));
    expect(impactFraction(drover, 18)).toBeLessThan(1);
    expect(impactFraction(drover, 21)).toBeGreaterThan(1);
  });

  it('a hard touchdown costs hull by that rule, once, and the shields do not help', () => {
    const t = pilot(padPoint(300, 80, 4));
    const up = upAt(t.ship.state.pos);
    t.ship.state.pos = padPoint(300, 80, t.ship.stats.belly + 3);
    t.ship.state.vel = v3.scale(up, -16);
    t.ship.input.buttons = Button.FaOff;
    const dealt = watchDamage();
    let sink = 0;
    const hit = runUntil(() => {
      if (dealt.length > 0) return true;
      // The speed into the ground on the tick of contact: this tick's plus one tick of gravity.
      sink = -v3.dot(t.ship.state.vel, up) + gravity * DT;
      return false;
    }, 3);
    expect(hit).toBe(true);
    expect(dealt).toHaveLength(1);
    const impact = sink - LAND_MAX_SINK;
    expect(impact).toBeGreaterThan(9.5);
    expect(impact).toBeLessThan(11.5);
    expect(dealt[0]!.amount / t.ship.stats.hullMax).toBeCloseTo(0.25 * (impact / 10) ** 1.5, 2);
    expect(t.ship.state.hull).toBeCloseTo(t.ship.stats.hullMax - dealt[0]!.amount, 6);
    expect(t.ship.state.shield).toBe(dealt[0]!.shield);
    expect(t.ship.state.mode).toBe(FlightMode.Normal);
    // The pilots around are shown a hit on the hull, at the ground under the ship.
    run(2);
    const shown = t.events.find((e) => e.e === 'hit' && e.id === t.ship.id) as Extract<GameEvent, { e: 'hit' }> | undefined;
    expect(shown?.shield).toBe(false);
    expect(Math.abs(altitude(shown!.at))).toBeLessThan(1);
    // It bounces, comes down again gently and stands; nothing more is charged.
    expect(runUntil(() => t.ship.state.mode === FlightMode.Landed, 20)).toBe(true);
    expect(dealt).toHaveLength(1);
    expect(t.ship.state.hull / t.ship.stats.hullMax).toBeGreaterThan(0.65);
    expect(t.ship.state.hull / t.ship.stats.hullMax).toBeLessThan(0.8);
  });

  it('scraping along the ground is one impact, not one per tick', () => {
    const t = pilot(padPoint(-300, 120, 4));
    t.ship.state.pos = padPoint(-300, 120, t.ship.stats.belly + 0.3);
    // Twenty metres per second along the pad, toward its middle but far from the block.
    const along = quat.rotate(padRot, [0, 0, -1]);
    t.ship.state.vel = v3.scale(along, 20);
    t.ship.input.buttons = Button.FaOff;
    const dealt = watchDamage();
    expect(runUntil(() => t.ship.state.mode === FlightMode.Landed, 30)).toBe(true);
    const lost = 1 - t.ship.state.hull / t.ship.stats.hullMax;
    // 12 m/s over the sideways limit: about a third of the hull, charged on the first contact.
    const expected = impactFraction(t.ship.stats, 20 - LAND_MAX_SIDE);
    expect(expected).toBeGreaterThan(0.3);
    expect(lost).toBeGreaterThan(expected * 0.8);
    expect(lost).toBeLessThan(expected * 1.1);
    expect(dealt.filter((d) => d.ship === t.ship)).toHaveLength(1);
    // The contacts of one slide follow each other well inside the time that makes them one impact.
    expect(IMPACT_EPISODE).toBeGreaterThanOrEqual(0.5);
  });

  it('a much harder one destroys the ship and leaves its wreck on the ground with the cargo', () => {
    const t = pilot(padPoint(320, -150, 4), 'drover');
    // Goods that neither scrap nor salvaged parts add to.
    t.p.addCargo('textiles', 5, world.id, false);
    t.p.addCargo('food', 3, 'elsewhere', false);
    const belly = t.ship.stats.belly;
    t.ship.state.pos = padPoint(320, -150, belly + 3);
    t.ship.state.vel = v3.scale(upAt(t.ship.state.pos), -45);
    t.ship.input.buttons = Button.FaOff;
    expect(runUntil(() => t.ship.state.mode === FlightMode.Dead, 3)).toBe(true);
    expect(t.notices.some((n) => n.code === 'crash')).toBe(true);
    expect(t.p.rec.passport.ship.cargo).toHaveLength(0);

    const wreck = objectsOf(EntityKind.Wreck).find((o) => o.info.name === `Wreck of ${t.ship.name}`)!;
    expect(wreck).toBeTruthy();
    const contents = wreckData(wreck)!.contents;
    expect(contents.find((x) => x.c === 'textiles' && x.origin === world.id)?.n).toBe(5);
    expect(contents.find((x) => x.c === 'food' && x.origin === 'elsewhere')?.n).toBe(3);
    // The wreck bounces off with the ship's last speed, falls back and comes to rest as the ship stood.
    expect(runUntil(() => wreck.resting === true, 30)).toBe(true);
    expect(altitude(wreck.pos)).toBeCloseTo(belly, 3);
    expect(v3.len(wreck.vel)).toBe(0);
    const at = [...wreck.pos];
    run(300);
    expect(wreck.pos).toEqual(at);
    expect(v3.dist(wreck.pos, padPoint(320, -150, belly))).toBeLessThan(200);
  });

  it('flying into a body that cannot be landed on still destroys the ship outright', () => {
    const solid = def.bodies.find((b) => b.kind !== 'star' && !isLandable(b))!;
    expect(solid, 'the capital has a planet that cannot be landed on').toBeTruthy();
    const t = pilot(padPoint(0, 0, 5000));
    // Just inside the exclusion radius of that body, in its own frame.
    Object.assign(t.ship.state, { anchor: solid.id, pos: [solid.radius * 1.03, 0, 0], vel: [0, 0, 0] });
    run(2);
    expect(t.ship.state.mode).toBe(FlightMode.Dead);
    expect(t.notices.some((n) => n.code === 'impact')).toBe(true);
    expect(t.notices.some((n) => n.code === 'crash')).toBe(false);
    // The same height over the moon with the base is just a place to fly: its ground is the limit.
    const u = pilot(padPoint(0, 0, 0.03 * body.radius));
    run(30);
    expect(u.ship.state.mode).toBe(FlightMode.Normal);
    expect(u.ship.state.hull).toBe(u.ship.stats.hullMax);
    sim.removeShip(u.ship);
    world.players.delete(u.p.id);
  });

  it('a ship destroyed above the ground leaves a wreck that falls to it', () => {
    const t = pilot(padPoint(-350, -200, 300));
    t.p.addCargo('textiles', 2, world.id, false);
    sim.destroy(t.ship, null);
    const wreck = objectsOf(EntityKind.Wreck).find((o) => o.info.name === `Wreck of ${t.ship.name}`)!;
    expect(wreck).toBeTruthy();
    const fall = Math.sqrt((2 * 300) / gravity);
    run(Math.round((0.5 * fall) / DT));
    expect(wreck.resting).not.toBe(true);
    expect(altitude(wreck.pos)).toBeLessThan(290);
    expect(runUntil(() => wreck.resting === true, fall)).toBe(true);
    expect(altitude(wreck.pos)).toBeCloseTo(t.ship.stats.belly, 3);
    expect(wreckData(wreck)!.contents.find((x) => x.c === 'textiles')?.n).toBe(2);
  });
});

describe('things on the ground', () => {
  it('cargo pods fall under gravity and come to rest on the terrain', () => {
    const start = padPoint(150, 300, 100);
    const pod = sim.spawnLoot(zone, start, [0, 0, 0], 'alloys', 4);
    const fall = Math.sqrt((2 * 98) / gravity);
    run(Math.round((0.6 * fall) / DT));
    expect(pod.resting).not.toBe(true);
    // Sixty percent of the fall time is thirty-six percent of the way.
    expect(100 - altitude(pod.pos)).toBeGreaterThan(0.3 * 98);
    expect(100 - altitude(pod.pos)).toBeLessThan(0.42 * 98);
    expect(runUntil(() => pod.resting === true, 0.6 * fall)).toBe(true);
    expect(altitude(pod.pos)).toBeCloseTo(pod.radius, 3);
    expect(v3.len(pod.vel)).toBe(0);
    expect(v3.dist(pod.pos, padPoint(150, 300, pod.radius))).toBeLessThan(1);
    sim.removeObject(pod.id);
  });

  it('a pod thrown sideways over natural ground still ends up on it', () => {
    const spot = levelSpot(9);
    const start = v3.addScaled(spot, upAt(spot), 60);
    const side = v3.normalize(v3.cross(upAt(spot), [0.3, 0.5, 0.8]));
    const pod = sim.spawnLoot(zone, start, v3.scale(side, 25), 'food', 1);
    expect(runUntil(() => pod.resting === true, 60)).toBe(true);
    expect(altitude(pod.pos)).toBeCloseTo(pod.radius, 3);
    expect(v3.dist(pod.pos, start)).toBeGreaterThan(60);
    sim.removeObject(pod.id);
  });

  it('a pod in space is not pulled anywhere', () => {
    const station = def.sites.find((s) => s.kind === 'station')!;
    const pod = sim.spawnLoot(station.id, [5000, 0, 0], [3, 0, 0], 'food', 1);
    run(90);
    expect(pod.pos[0]).toBeCloseTo(5000 + 9, 6);
    expect(pod.pos[1]).toBe(0);
    expect(pod.resting).not.toBe(true);
    sim.removeObject(pod.id);
  });

  it('a missile that meets the ground goes off there', () => {
    const start = padPoint(-150, -350, 80);
    const id = world.allocId();
    sim.addObject({
      id, kind: EntityKind.Missile, anchor: zone, pos: v3.clone(start), vel: v3.scale(upAt(start), -200), rot: [0, 0, 0, 1], radius: 1,
      info: { id, kind: EntityKind.Missile, name: 'Missile', model: 'missile', radius: 1 }, ttl: 14,
      data: { missile: true, from: -1, target: null, dmg: 210, shieldMul: 1, hullMul: 1, speed: 200, seeker: 0, tracking: false },
    });
    const events = watchEvents();
    expect(runUntil(() => !sim.objects.has(id), 2)).toBe(true);
    const blast = events.find((e) => e.ev.e === 'hit' && e.ev.id === id);
    expect(blast?.zone).toBe(zone);
    expect(Math.abs(altitude((blast!.ev as { at: Vec3 }).at))).toBeLessThan(2);
  });

  it('a landed ship does not scoop; the same ship in flight does', () => {
    const t = pilot(padPoint(200, -300, 4));
    standAt(t.ship, padPoint(200, -300, 0));
    const pod = sim.spawnLoot(zone, padPoint(230, -300, 2), [0, 0, 0], 'alloys', 2);
    expect(v3.dist(pod.pos, t.ship.state.pos)).toBeLessThan(SCOOP_RANGE);
    run(60);
    expect(t.p.cargoCount('alloys')).toBe(0);
    t.ship.input.thrust = [0, 1, 0];
    expect(runUntil(() => t.p.cargoCount('alloys') === 2, 5)).toBe(true);
    expect(t.ship.state.mode).toBe(FlightMode.Normal);
  });
});

describe('a landed ship in a fight', () => {
  it('can be detected, locked and hit, and takes the damage', () => {
    const spot = levelSpot(8);
    expect(v3.dist(spot, base.ground!.pos)).toBeGreaterThan(MASS_LOCK_RADIUS);
    const t = pilot(v3.addScaled(spot, upAt(spot), 5));
    standAt(t.ship, spot);
    // The attacker hovers 500 m off and 250 m up, nose on the target.
    const side = v3.normalize(v3.cross(upAt(spot), [0.2, 0.9, 0.4]));
    const from = v3.add(v3.addScaled(spot, side, 500), v3.scale(upAt(spot), 250));
    // Its nose is two and a half degrees off, inside the gimbal: only a lock brings the shots home.
    const to = v3.normalize(v3.sub(t.ship.state.pos, from));
    const off = v3.normalize(v3.cross(to, upAt(from)));
    const attacker = drone(from, quat.lookRotation(v3.addScaled(to, off, Math.tan((2.5 * Math.PI) / 180)), upAt(from)));
    attacker.target = t.ship.id;
    run(2);
    expect(sim.shipsInZone(zone)).toContain(t.ship);
    expect(sim.detects(attacker, t.ship)).toBe(true);
    attacker.input.buttons = Button.Fire1;
    const shield = t.ship.state.shield;
    run(90);
    attacker.input.buttons = 0;
    expect(t.ship.state.mode).toBe(FlightMode.Landed);
    expect(t.ship.state.shield).toBeLessThan(shield);
    expect(t.events.some((e) => e.e === 'hit' && e.id === t.ship.id)).toBe(true);
    expect(t.events.some((e) => e.e === 'shot' && e.from === attacker.id && e.to === t.ship.id)).toBe(true);
    // Shot down where it stands, it leaves its wreck there.
    sim.damage(t.ship, 1e6, { by: attacker });
    expect(t.ship.state.mode).toBe(FlightMode.Dead);
    const wreck = objectsOf(EntityKind.Wreck).find((o) => o.info.name === `Wreck of ${t.ship.name}`)!;
    expect(wreck).toBeTruthy();
    run(30);
    expect(wreck.resting).toBe(true);
    expect(altitude(wreck.pos)).toBeCloseTo(t.ship.stats.belly, 3);
    sim.removeShip(attacker);
  });

  it('cannot fire until it has lifted off', () => {
    const spot = levelSpot(11);
    const t = pilot(v3.addScaled(spot, upAt(spot), 5));
    standAt(t.ship, spot);
    // A target straight ahead of the standing ship's nose.
    const nose = quat.rotate(t.ship.state.rot, [0, 0, -1]);
    const targetPos = v3.addScaled(t.ship.state.pos, nose, 300);
    const target = drone(v3.addScaled(targetPos, upAt(targetPos), Math.max(0, 30 - altitude(targetPos))), quat.clone(padRot));
    t.ship.target = target.id;
    const events = watchEvents();
    t.ship.input.buttons = Button.Fire1;
    run(90);
    expect(t.ship.state.mode).toBe(FlightMode.Landed);
    expect(events.some((e) => e.ev.e === 'shot' && e.ev.from === t.ship.id)).toBe(false);
    expect(target.state.shield).toBe(target.stats.shieldMax);
    expect(t.ship.flags & EntityFlag.Firing).toBe(0);
    // Off the ground the same trigger fires.
    t.ship.input.thrust = [0, 1, 0];
    run(20);
    t.ship.input.thrust = [0, 0, 0];
    run(40);
    expect(t.ship.state.mode).toBe(FlightMode.Normal);
    expect(events.some((e) => e.ev.e === 'shot' && e.ev.from === t.ship.id)).toBe(true);
    sim.removeShip(target);
  });

  it('weapons are locked around a base in secure space, as around a station', () => {
    expect(def.security).toBe('secure');
    const t = pilot(padPoint(600, 600, 200));
    const target = drone(padPoint(600, 900, 200), quat.clone(padRot));
    t.ship.state.rot = quat.lookRotation(v3.sub(target.state.pos, t.ship.state.pos), upAt(t.ship.state.pos));
    const events = watchEvents();
    t.ship.input.buttons = Button.Fire1;
    run(60);
    expect(events.some((e) => e.ev.e === 'shot' && e.ev.from === t.ship.id)).toBe(false);
    expect(t.notices.some((n) => n.code === 'weapons_locked')).toBe(true);
    sim.removeShip(target);
  });

  it('a shot ends at the ground instead of passing through it', () => {
    const spot = levelSpot(13);
    const up = upAt(spot);
    const side = v3.normalize(v3.cross(up, [0.7, 0.1, 0.5]));
    const t = pilot(v3.addScaled(spot, up, 150));
    // Nose thirty degrees below the horizon: the ground is about 300 m along the shot.
    const dir = v3.normalize(v3.add(v3.scale(side, Math.cos(Math.PI / 6)), v3.scale(up, -Math.sin(Math.PI / 6))));
    t.ship.state.rot = quat.lookRotation(dir, up);
    const events = watchEvents();
    t.ship.input.buttons = Button.Fire1;
    run(20);
    t.ship.input.buttons = 0;
    const shots = events.filter((e) => e.ev.e === 'shot' && e.ev.from === t.ship.id).map((e) => e.ev as Extract<GameEvent, { e: 'shot' }>);
    expect(shots.length).toBeGreaterThan(0);
    for (const s of shots) {
      expect(Math.abs(altitude(s.at))).toBeLessThan(3);
      expect(v3.dist(s.at, t.ship.state.pos)).toBeLessThan(1000);
    }
  });

  it('the ray against the terrain is exact where it hits and free where it cannot', () => {
    const spot = levelSpot(15);
    const up = upAt(spot);
    const origin = v3.addScaled(spot, up, 400);
    const down = groundRay(surface, origin, v3.neg(up), 3000);
    expect(down).toBeGreaterThan(395);
    expect(down).toBeLessThan(405);
    expect(Math.abs(altitude(v3.addScaled(origin, up, -down)))).toBeLessThan(1);
    // Too short to reach, pointing away, and starting underground.
    expect(groundRay(surface, origin, v3.neg(up), 300)).toBe(-1);
    expect(groundRay(surface, origin, up, 5000)).toBe(-1);
    expect(groundRay(surface, v3.addScaled(spot, up, -5), up, 100)).toBe(0);
    // Far above the highest ground nothing is sampled and nothing is hit.
    const high = v3.scale(up, surface.top + 5000);
    const level = v3.normalize(v3.cross(up, [0.1, 0.2, 0.9]));
    expect(groundRay(surface, high, level, 6000)).toBe(-1);
  });
});

describe('a landed ship among others', () => {
  it('is hit by cannon shells that were under way and by a missile that had to turn for it', () => {
    const spot = levelSpot(21);
    const up = upAt(spot);
    const t = pilot(v3.addScaled(spot, up, 5));
    standAt(t.ship, spot);
    const side = v3.normalize(v3.cross(up, [0.5, 0.2, 0.8]));
    const from = v3.add(v3.addScaled(spot, side, 500), v3.scale(up, 250));
    const gunner = drone(from, quat.lookRotation(v3.sub(t.ship.state.pos, from), upAt(from)), 'lancet');
    gunner.target = t.ship.id;
    run(2);
    const shield = t.ship.state.shield;
    // The secondary group of a stock Lancet is its cannon: shells that take a moment to arrive.
    gunner.input.buttons = Button.Fire2;
    run(60);
    gunner.input.buttons = 0;
    run(30);
    expect(t.ship.state.mode).toBe(FlightMode.Landed);
    expect(t.ship.state.shield).toBeLessThan(shield);

    t.ship.state.shield = t.ship.stats.shieldMax;
    t.ship.state.hull = t.ship.stats.hullMax;
    const start = v3.add(v3.addScaled(spot, side, -700), v3.scale(up, 400));
    const toTarget = v3.normalize(v3.sub(t.ship.state.pos, start));
    // Launched twenty-five degrees off the line to the target.
    const launch = v3.normalize(v3.addScaled(toTarget, v3.normalize(v3.cross(toTarget, up)), Math.tan((25 * Math.PI) / 180)));
    const id = world.allocId();
    sim.addObject({
      id, kind: EntityKind.Missile, anchor: zone, pos: v3.clone(start), vel: v3.scale(launch, 650), rot: quat.lookRotation(launch), radius: 1,
      info: { id, kind: EntityKind.Missile, name: 'Missile', model: 'missile', radius: 1 }, ttl: 14,
      data: { missile: true, from: gunner.id, target: t.ship.id, dmg: 120, shieldMul: 1, hullMul: 1, speed: 650, seeker: 12_000, tracking: true },
    });
    expect(runUntil(() => !sim.objects.has(id), 6)).toBe(true);
    expect(t.ship.state.shield).toBeLessThan(t.ship.stats.shieldMax);
    expect(t.ship.state.mode).toBe(FlightMode.Landed);
    sim.removeShip(gunner);
  });

  it('does not give way when it is rammed: the other ship bounces off and both take the damage', () => {
    const t = pilot(padPoint(-250, -250, 4));
    standAt(t.ship, padPoint(-250, -250, 0));
    const pos = [...t.ship.state.pos];
    const east = quat.rotate(padRot, [1, 0, 0]);
    const rammer = drone(padPoint(-340, -250, t.ship.stats.belly + 1), quat.lookRotation(east, upAt(base.ground!.pos)));
    rammer.input.thrust = [0, 0, 0.12];
    let nearest = Infinity;
    let bounced = false;
    for (let i = 0; i < 4 / DT; i++) {
      run(1);
      nearest = Math.min(nearest, v3.dist(rammer.state.pos, t.ship.state.pos));
      if (v3.dot(rammer.state.vel, east) < -1) bounced = true;
    }
    expect(bounced).toBe(true);
    expect(t.ship.state.mode).toBe(FlightMode.Landed);
    expect(t.ship.state.pos).toEqual(pos);
    // The two hulls never overlap: the flying ship alone is moved out of the way.
    expect(nearest).toBeGreaterThan(t.ship.stats.radius + rammer.stats.radius - 0.01);
    expect(t.ship.state.shield).toBeLessThan(t.ship.stats.shieldMax);
    expect(rammer.state.shield).toBeLessThan(rammer.stats.shieldMax);
    sim.removeShip(rammer);
  });

  it('receives fuel from a ship in flight, and can survey the body it stands on', async () => {
    const spot = levelSpot(24);
    const t = pilot(v3.addScaled(spot, upAt(spot), 5), 'wayfarer');
    standAt(t.ship, spot);
    t.ship.state.fuel = t.ship.stats.fuelCap - 5;
    const giver = pilot(v3.addScaled(spot, upAt(spot), 200));
    run(2);
    expect(await cmd(giver, { k: 'giveFuel', to: t.ship.id, n: 2 })).toMatchObject({ ok: true, data: { n: 2 } });
    expect(t.ship.state.fuel).toBeCloseTo(t.ship.stats.fuelCap - 3, 6);
    // The other way round it is refused: a fuel line needs the giving ship in flight.
    expect(await cmd(t, { k: 'giveFuel', to: giver.ship.id, n: 1 })).toMatchObject({ ok: false });
    expect(t.ship.stats.scanner).toBe(true);
    expect(await cmd(t, { k: 'scan', body: body.id })).toMatchObject({ ok: true });
    expect(t.ship.state.mode).toBe(FlightMode.Landed);
  });

  it('cannot work a wreck with its mining laser until it has lifted off', () => {
    const spot = levelSpot(27);
    const t = pilot(v3.addScaled(spot, upAt(spot), 8), 'delver');
    standAt(t.ship, spot);
    const nose = quat.rotate(t.ship.state.rot, [0, 0, -1]);
    const ahead = v3.addScaled(t.ship.state.pos, nose, 120);
    const hauler = drone(v3.addScaled(ahead, upAt(ahead), Math.max(0, 20 - altitude(ahead))), quat.clone(padRot), 'drover');
    hauler.cargo = [{ c: 'textiles', n: 30, origin: world.id }];
    sim.destroy(hauler, null);
    const wreck = objectsOf(EntityKind.Wreck).find((o) => o.info.name === 'Wreck of Drone' && v3.dist(o.pos, ahead) < 100)!;
    expect(runUntil(() => wreck.resting === true, 30)).toBe(true);
    const pods = objectsOf(EntityKind.Loot).length;
    t.ship.input.buttons = Button.Fire3;
    run(120);
    expect(t.ship.state.mode).toBe(FlightMode.Landed);
    expect(wreckData(wreck)!.fill).toBe(1);
    expect(objectsOf(EntityKind.Loot).length).toBe(pods);
    expect(t.ship.flags & EntityFlag.Mining).toBe(0);
    t.ship.input.thrust = [0, 1, 0];
    run(15);
    t.ship.input.thrust = [0, 0, 0];
    expect(runUntil(() => wreckData(wreck)!.fill < 1, 10)).toBe(true);
    expect(t.ship.state.mode).toBe(FlightMode.Normal);
    // What is cut loose comes out as pods, and the ship, now in flight and in range, scoops them.
    expect(runUntil(() => t.p.cargoCount('textiles') > 0, 10)).toBe(true);
  });
});

describe('what is refused on the ground', () => {
  it('no cruise, no fold and no jettison while landed; a charge in progress ends at touchdown', async () => {
    const spot = levelSpot(18);
    const t = pilot(v3.addScaled(spot, upAt(spot), 1.2 + 2.7), 'wisp', 0);
    t.p.addCargo('alloys', 2, world.id, false);
    // Falling the last metre with a fold charge running.
    const target = reachableSystem();
    t.ship.state.chargeKind = 2;
    t.ship.state.charge = 0.2;
    t.ship.fold = { system: target, server: null, distance: 1 };
    t.ship.input.buttons = Button.FaOff;
    expect(runUntil(() => t.ship.state.mode === FlightMode.Landed, 10)).toBe(true);
    run(1);
    expect(t.ship.state.chargeKind).toBe(0);
    expect(t.ship.fold).toBeNull();
    expect(t.notices.some((n) => n.code === 'charge_landed')).toBe(true);

    expect(await cmd(t, { k: 'cruise', on: true })).toMatchObject({ ok: false, err: 'Lift off first.' });
    expect(await cmd(t, { k: 'fold', system: target })).toMatchObject({ ok: false, err: 'Lift off first.' });
    expect(await cmd(t, { k: 'jettison', c: 'alloys', n: 1 })).toMatchObject({ ok: false, err: 'Lift off first.' });
    run(300);
    expect(t.ship.state.mode).toBe(FlightMode.Landed);
    expect(t.ship.state.chargeKind).toBe(0);
    expect(t.p.cargoCount('alloys')).toBe(2);
  });

  it('below the cruise ceiling neither drive charges, and says why', async () => {
    const t = pilot(padPoint(5000, 5000, 800));
    expect(await cmd(t, { k: 'cruise', on: true })).toMatchObject({ ok: false, err: 'Too close to the ground: climb above the cruise ceiling.' });
    expect(await cmd(t, { k: 'fold', system: reachableSystem() })).toMatchObject({ ok: false, err: 'Too close to the ground: climb above the cruise ceiling.' });
    expect(t.ship.state.chargeKind).toBe(0);
    // High above the ceiling the same commands start a charge.
    const up = upAt(t.ship.state.pos);
    t.ship.state.pos = v3.scale(up, surface.ceiling + 3000);
    expect(await cmd(t, { k: 'cruise', on: true })).toMatchObject({ ok: true });
    expect(t.ship.state.chargeKind).toBe(1);
  });
});

describe('cruise at the ceiling', () => {
  it('ends without harm in the surface frame, and the pilot and the zone are told', () => {
    const t = pilot(padPoint(0, 20_000, 3000));
    const up = upAt(t.ship.state.pos);
    // In cruise 400 m above the ceiling, nose straight down.
    Object.assign(t.ship.state, {
      mode: FlightMode.Cruise, anchor: body.id, pos: quat.rotate(toSystemAxes(), v3.scale(up, surface.ceiling + 400)),
      rot: quat.lookRotation(quat.rotate(toSystemAxes(), v3.neg(up))), throttle: 0, cruiseSpeed: 250,
    });
    const events = watchEvents();
    expect(runUntil(() => t.ship.state.mode === FlightMode.Normal, 5)).toBe(true);
    expect(t.ship.state.anchor).toBe(zone);
    expect(t.ship.state.hull).toBe(t.ship.stats.hullMax);
    expect(v3.len(t.ship.state.pos)).toBeLessThan(surface.ceiling);
    expect(t.notices.some((n) => n.code === 'cruise_ceiling')).toBe(true);
    expect(events.some((e) => e.zone === zone && e.ev.e === 'cruise' && e.ev.id === t.ship.id && !e.ev.on)).toBe(true);
    expect(events.some((e) => e.zone === -2 && e.ev.e === 'cruise' && e.ev.id === t.ship.id && !e.ev.on)).toBe(true);
  });
});

describe('ground bases', () => {
  let t: TestPilot;

  it('docking needs the ship near the pad and slow over the ground', async () => {
    t = pilot(padPoint(0, 0, (base.radius ?? 300) + DOCK_RANGE + 400), 'wisp', 50_000);
    expect(await cmd(t, { k: 'dock' })).toMatchObject({ ok: false, err: 'Too far from the base.' });
    t.ship.state.pos = padPoint(300, 0, 150);
    t.ship.state.vel = v3.scale(quat.rotate(padRot, [1, 0, 0]), 200);
    expect(await cmd(t, { k: 'dock' })).toMatchObject({ ok: false, err: 'Too fast to dock.' });
    expect(t.ship.state.mode).toBe(FlightMode.Normal);
  });

  it('dock, trade and undock work at a base as at a station', async () => {
    t.ship.state.vel = [0, 0, 0];
    const events = watchEvents();
    expect(await cmd(t, { k: 'dock' })).toMatchObject({ ok: true, data: { site: base.id } });
    expect(t.ship.state.mode).toBe(FlightMode.Docked);
    expect(t.ship.state.anchor).toBe(base.id);
    expect(t.p.rec.homeSite).toBe(base.id);
    expect(events.some((e) => e.zone === zone && e.ev.e === 'dock' && e.ev.id === t.ship.id && e.ev.docked)).toBe(true);
    run(5);
    expect(sim.shipsInZone(zone)).not.toContain(t.ship);

    const view = world.stationView(t.p)!;
    expect(view.site).toBe(base.id);
    expect(view.services).toContain('market');
    const row = view.market.find((r) => r.buy > 0 && r.stock >= 2)!;
    expect(row, 'the base sells something').toBeTruthy();
    const credits = t.p.rec.credits;
    expect(await cmd(t, { k: 'buy', c: row.c, n: 2 })).toMatchObject({ ok: true });
    expect(t.p.cargoCount(row.c)).toBe(2);
    expect(t.p.rec.credits).toBeLessThan(credits);
    expect(await cmd(t, { k: 'sell', c: row.c, n: 2 })).toMatchObject({ ok: true });
    expect(t.p.cargoCount(row.c)).toBe(0);
    t.ship.state.fuel = t.ship.stats.fuelCap - 1;
    expect(await cmd(t, { k: 'refuel' })).toMatchObject({ ok: true });
    expect(t.ship.state.fuel).toBeCloseTo(t.ship.stats.fuelCap, 6);
    // The mission board of the base is the station code too.
    expect(view.services).toContain('missions');
    expect(view.missions.length).toBeGreaterThan(0);

    expect(await cmd(t, { k: 'undock' })).toMatchObject({ ok: true });
    expect(t.ship.state.mode).toBe(FlightMode.Normal);
    expect(t.ship.state.anchor).toBe(zone);
    expect(events.some((e) => e.zone === zone && e.ev.e === 'dock' && e.ev.id === t.ship.id && !e.ev.docked)).toBe(true);
    const out = (base.radius ?? 300) + 500;
    expect(v3.dist(t.ship.state.pos, base.ground!.pos)).toBeCloseTo(out, 3);
    expect(altitude(t.ship.state.pos)).toBeGreaterThan(out * 0.9);
    expect(v3.len(t.ship.state.vel)).toBe(0);
    // Flight assist holds it there: ten seconds later it has neither fallen nor drifted off.
    run(10 / DT);
    expect(t.ship.state.mode).toBe(FlightMode.Normal);
    expect(v3.dist(t.ship.state.pos, base.ground!.pos)).toBeGreaterThan(out - 20);
    expect(v3.dist(t.ship.state.pos, base.ground!.pos)).toBeLessThan(out + 20);
    expect(sim.shipsInZone(zone)).toContain(t.ship);
  });

  it('a ship standing on the pad can dock too', async () => {
    standAt(t.ship, padPoint(200, 100, 0));
    run(2);
    expect(t.ship.state.mode).toBe(FlightMode.Landed);
    expect(await cmd(t, { k: 'dock' })).toMatchObject({ ok: true });
    expect(t.ship.state.mode).toBe(FlightMode.Docked);
    expect(await cmd(t, { k: 'undock' })).toMatchObject({ ok: true });
  });

  it('a delivery to a base can be handed in there', async () => {
    const station = def.sites.find((s) => s.kind === 'station')!;
    const { offersFor } = await import('../packages/server/src/modules/missions.ts');
    // The boards change every slot; look through the slots for a haul from the station to the base.
    let job: ReturnType<typeof offersFor>[number] | undefined;
    for (let i = 0; i < 400 && !job; i++) {
      job = offersFor(world, sim, station, sim.time).find((m) => m.kind === 'delivery' && m.destSite === base.id && m.destSystem === def.id);
      if (!job) {
        c.nowMs += 1_800_000;
        run(1);
      }
    }
    expect(job, 'some board offers a delivery to the base').toBeTruthy();
    Object.assign(t.ship.state, { mode: FlightMode.Docked, anchor: station.id, pos: [0, 0, 0], vel: [0, 0, 0] });
    expect(await cmd(t, { k: 'missionAccept', id: job!.id })).toMatchObject({ ok: true });
    Object.assign(t.ship.state, { mode: FlightMode.Normal, anchor: zone, pos: padPoint(250, 50, 80), vel: [0, 0, 0], rot: quat.clone(padRot) });
    run(2);
    expect(await cmd(t, { k: 'dock' })).toMatchObject({ ok: true });
    const credits = t.p.rec.credits;
    expect(await cmd(t, { k: 'missionComplete', id: job!.id })).toMatchObject({ ok: true });
    expect(t.p.rec.credits).toBeGreaterThan(credits);
  });

  it('a destroyed pilot whose home is a base respawns docked there, insured as at a station', async () => {
    expect(t.p.rec.homeSite).toBe(base.id);
    expect(await cmd(t, { k: 'undock' })).toMatchObject({ ok: true });
    run(5);
    sim.destroy(t.ship, null);
    expect(t.ship.state.mode).toBe(FlightMode.Dead);
    const credits = t.p.rec.credits;
    expect(await cmd(t, { k: 'respawn' })).toMatchObject({ ok: true });
    const ship = t.p.ship!;
    expect(ship.state.mode).toBe(FlightMode.Docked);
    expect(ship.state.anchor).toBe(base.id);
    expect(ship.state.hull).toBe(ship.stats.hullMax);
    expect(t.p.rec.credits).toBeLessThan(credits);
    expect(world.stationView(t.p)?.site).toBe(base.id);
    expect(await cmd(t, { k: 'undock' })).toMatchObject({ ok: true });
    expect(ship.state.anchor).toBe(zone);
    expect(altitude(ship.state.pos)).toBeGreaterThan(500);
  });

  it('a ship standing beside the block is left alone, and nothing is ever pushed into the ground', () => {
    const block = BASE_COLLIDER.colliders[0] as { r: number; y1: number };
    // Closer to the block than a flying ship of its size could be.
    const s = pilot(padPoint(block.r + 5, 0, 4));
    standAt(s.ship, padPoint(block.r + 5, 0, 0));
    const pos = [...s.ship.state.pos];
    run(60);
    expect(s.ship.state.mode).toBe(FlightMode.Landed);
    expect(s.ship.state.pos).toEqual(pos);
    sim.removeShip(s.ship);
    world.players.delete(s.p.id);

    const padUp = quat.rotate(padRot, [0, 1, 0]);
    let contacts = 0;
    for (let east = 0; east <= block.r + 8; east += 4) {
      for (let up = 0; up <= block.y1 + 8; up += 2) {
        const hit = collideBase(padPose(base), padPoint(east, 3, up), 9);
        if (!hit) continue;
        contacts++;
        expect(v3.dot(hit.normal, padUp)).toBeGreaterThanOrEqual(-1e-9);
        expect(hit.depth).toBeGreaterThan(0);
      }
    }
    expect(contacts).toBeGreaterThan(100);
    expect(collideBase(padPose(base), padPoint(block.r + 60, 0, 10), 9)).toBeNull();
  });

  it('ships collide with the base structure and never get inside it', () => {
    const block = BASE_COLLIDER.colliders[0] as { r: number; y1: number };
    const f = pilot(padPoint(-135, 0, 20));
    f.ship.state.vel = v3.scale(quat.rotate(padRot, [1, 0, 0]), 40);
    f.ship.input.buttons = Button.FaOff;
    const dealt = watchDamage();
    let nearest = Infinity;
    for (let i = 0; i < 20 / DT; i++) {
      run(1);
      if (f.ship.state.mode === FlightMode.Dead) break;
      const local = quat.unrotate(padRot, v3.sub(f.ship.state.pos, base.ground!.pos));
      if (local[1] < block.y1 + f.ship.stats.radius) nearest = Math.min(nearest, Math.hypot(local[0], local[2]));
    }
    expect(nearest).toBeGreaterThan(block.r + f.ship.stats.radius - 0.5);
    expect(dealt.some((d) => d.ship === f.ship && d.amount > 0)).toBe(true);
    // It was thrown back the way it came.
    const local = quat.unrotate(padRot, v3.sub(f.ship.state.pos, base.ground!.pos));
    expect(local[0]).toBeLessThan(-(block.r + f.ship.stats.radius) + 1);
  });
});

describe('saved states', () => {
  it('a ship saved as landed anywhere but in a surface frame is not put back as it is', async () => {
    const station = def.sites.find((s) => s.kind === 'station')!;
    for (const anchor of [station.id, body.id]) {
      const bot = c.track(await Bot.connect(S.url, { name: `Stray ${anchor}` }));
      const ship = world.players.get(bot.id)!.ship!;
      Object.assign(ship.state, { mode: FlightMode.Landed, anchor, pos: [0, 5000, 0], vel: [0, 0, 0] });
      bot.close();
      await c.settle(() => !world.players.has(bot.id), 'the pilot to be logged out');
      c.bots.delete(bot);
      const again = c.track(await Bot.connect(S.url, { keys: bot.keys, name: `Stray ${anchor}` }));
      await c.run(4);
      // Back in the dock at home instead.
      expect(again.self?.mode).toBe(FlightMode.Docked);
      again.close();
      await c.settle(() => !world.players.has(bot.id), 'the pilot to be logged out');
      c.bots.delete(again);
    }
  });
});

describe('two pilots at the same base', () => {
  it('see each other, landed or flying, and hear each other on the local channel', async () => {
    const a = c.track(await Bot.connect(S.url, { name: 'Ground Crew' }));
    const b = c.track(await Bot.connect(S.url, { name: 'Overflight' }));
    const shipA = world.players.get(a.id)!.ship!;
    const shipB = world.players.get(b.id)!.ship!;
    standAt(shipA, padPoint(180, 180, 0));
    Object.assign(shipB.state, { mode: FlightMode.Normal, anchor: zone, pos: padPoint(180, 480, 120), vel: [0, 0, 0], rot: quat.clone(padRot) });
    await c.run(12);

    const seenByB = b.snap!.ents.find((e) => e.id === shipA.id)!;
    const seenByA = a.snap!.ents.find((e) => e.id === shipB.id)!;
    expect(seenByB, 'the flying pilot sees the landed one').toBeTruthy();
    expect(seenByA, 'the landed pilot sees the flying one').toBeTruthy();
    expect(seenByB.flags & EntityFlag.Landed).toBe(EntityFlag.Landed);
    expect(seenByA.flags & EntityFlag.Landed).toBe(0);
    expect(a.self?.mode).toBe(FlightMode.Landed);
    // Offsets are in the axes of the shared surface frame.
    expect(v3.dist(v3.add(b.self!.pos, seenByB.pos), shipA.state.pos)).toBeLessThan(0.5);
    expect(v3.dist(v3.add(a.self!.pos, seenByA.pos), shipB.state.pos)).toBeLessThan(0.5);
    expect(b.ents.get(shipA.id)?.name).toBe('Ground Crew');

    expect(await a.cmd({ k: 'chat', ch: 'local', text: 'pad is clear' })).toMatchObject({ ok: true });
    await c.settle(() => b.chats.some((m) => m.text === 'pad is clear'), 'the local chat to arrive');
    a.close();
    b.close();
  });
});

describe('NPC traffic and the ground', () => {
  it('is never spawned in a surface frame', () => {
    expect(() => spawnNpc(sim, zone, 'trader')).toThrow(/surface frame/);
    // No site kind that has a population quota is a ground site, and a surface zone has no site at all.
    expect(isSurfaceAnchor(zone)).toBe(true);
    for (const z of sim.activeZones()) {
      if (!isSurfaceAnchor(z)) continue;
      for (const ship of sim.shipsInZone(z)) expect(ship.npc).toBeNull();
    }
  });

  it('is taken out the moment the flight step would move it into one', () => {
    // An NPC in the body frame just above the height where the surface frame begins, diving.
    const up = upAt(base.ground!.pos);
    const start = quat.rotate(toSystemAxes(), v3.scale(up, surface.enter + 150));
    const npc = spawnNpc(sim, body.id, 'pirate', start);
    npc.state.vel = quat.rotate(toSystemAxes(), v3.scale(up, -300));
    // Looks at every ship right after the ships were stepped, before anything else in the tick
    // (the population check among it) could tidy up.
    let inSurface = false;
    const probe: GameModule = {
      name: 'probe',
      postStep(s) {
        for (const ship of s.ships.values()) if (ship.npc !== null && isSurfaceAnchor(ship.state.anchor)) inSurface = true;
        for (const z of s.activeZones()) if (isSurfaceAnchor(z) && s.shipsInZone(z).some((ship) => ship.npc !== null)) inSurface = true;
      },
    };
    world.modules.push(probe);
    let ticks = 0;
    let below = false;
    try {
      while (sim.ships.has(npc.id) && ticks < 120) {
        run(1);
        ticks++;
        if (v3.len(npc.state.pos) < surface.enter) below = true;
      }
    } finally {
      world.modules.splice(world.modules.indexOf(probe), 1);
    }
    expect(below, 'the NPC really came below the height where the surface frame begins').toBe(true);
    expect(sim.ships.has(npc.id)).toBe(false);
    expect(npc.gone).toBe(true);
    expect(inSurface).toBe(false);
    // It left because it crossed, not because the population check found it a second later.
    expect(ticks).toBeLessThan(25);
  });
});
