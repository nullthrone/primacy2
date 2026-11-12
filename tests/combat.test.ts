/**
 * Combat and NPC tests: a real server world on a manually advanced clock, with ships placed
 * directly into the simulation so every situation is exact and repeatable.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  Button,
  DT,
  EntityFlag,
  EntityKind,
  FlightMode,
  MASS_LOCK_RADIUS,
  computeShipStats,
  newPassport,
  newShipState,
  quat,
  starterLoadout,
  v3,
  type GameEvent,
  type Loadout,
  type S2C,
  type Security,
  type SiteDef,
  type SystemDef,
  type Vec3,
} from '@primacy2/shared';
import { Player, newShip, type GameModule, type PlayerRecord, type PrimacyServer, type Ship, type SystemSim, type World } from '@primacy2/server';
import { Cluster } from './harness.ts';
import { pendingImpacts } from '../packages/server/src/modules/combat/weapons.ts';
import { spawnNpc } from '../packages/server/src/modules/npc.ts';

const c = new Cluster();
let S: PrimacyServer;
let world: World;
let npcModule: GameModule;
let npcIndex = -1;
/** A station or outpost and the system it is in. */
let port: { def: SystemDef; site: SiteDef };
/** An asteroid field and the system it is in. */
let field: { def: SystemDef; site: SiteDef };

const spies = new WeakMap<SystemSim, GameEvent[]>();
const securityBefore = new Map<SystemDef, Security>();
let pilots = 0;

/** Events emitted in a simulation since the list was last cleared. */
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

const shots = (evs: GameEvent[], from: number) => evs.filter((e): e is Extract<GameEvent, { e: 'shot' }> => e.e === 'shot' && e.from === from);
const hits = (evs: GameEvent[], id: number) => evs.filter((e): e is Extract<GameEvent, { e: 'hit' }> => e.e === 'hit' && e.id === id);

/** Advances the server synchronously: no sockets are involved in these tests. */
function run(ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    c.nowMs += DT * 1000;
    S.tick();
  }
}

function setSecurity(sim: SystemSim, level: Security): void {
  if (!securityBefore.has(sim.def)) securityBefore.set(sim.def, sim.def.security);
  sim.def.security = level;
}

/** Places an unmanned ship at rest, nose toward -Z. */
function place(sim: SystemSim, fit: string | Loadout, zone: number, pos: Vec3, name = 'Drone'): Ship {
  const loadout = typeof fit === 'string' ? starterLoadout(fit) : fit;
  const stats = computeShipStats(loadout);
  const state = newShipState(stats);
  state.anchor = zone;
  state.pos = v3.clone(pos);
  const ship = newShip(world.allocId(), name, loadout, stats, state);
  sim.addShip(ship);
  return ship;
}

interface TestPilot {
  ship: Ship;
  p: Player;
  notices: Extract<S2C, { t: 'notice' }>[];
}

/** Places a ship flown by a pilot who has a record and a (recording) connection but no socket. */
function pilot(sim: SystemSim, hull: string, zone: number, pos: Vec3, credits = 10_000): TestPilot {
  const id = `test-pilot-${++pilots}`;
  const passport = newPassport(id, `Pilot ${pilots}`, world.id);
  passport.ship.loadout = starterLoadout(hull);
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
  const ship = place(sim, passport.ship.loadout, zone, pos, p.name);
  ship.player = p;
  ship.cargo = passport.ship.cargo;
  p.ship = ship;
  p.sim = sim;
  sim.addShip(ship);
  return { ship, p, notices };
}

/** Makes a ship survive any amount of fire, with shields that stay down. */
function harden(ship: Ship): void {
  ship.stats = { ...ship.stats, hullMax: 1e7 };
  ship.state.hull = 1e7;
}

/** Leaves a ship one hit from destruction. */
function weaken(ship: Ship): void {
  ship.state.hull = 1;
  ship.state.shield = 0;
  ship.state.shieldDelay = 1e6;
}

const law = (t: TestPilot) => t.p.rec.data.combat as { bounty: number; wantedUntil: number } | undefined;

/** A spot well outside the weapons lock of a port. */
const OPEN: Vec3 = [20_000, 0, 0];
const ahead = (p: Vec3, metres: number): Vec3 => [p[0], p[1], p[2] - metres];

beforeAll(async () => {
  S = await c.start({ name: 'Combat', seed: 'combat' });
  world = S.world;
  // NPCs would wander into the firing lines; they get their own tests below.
  npcIndex = world.modules.findIndex((m) => m.name === 'npc');
  npcModule = world.modules[npcIndex]!;
  world.modules.splice(npcIndex, 1);

  for (const def of world.defs.values()) {
    for (const site of def.sites) {
      if (!port && (site.kind === 'station' || site.kind === 'outpost')) port = { def, site };
      if (!field && (site.kind === 'belt' || site.kind === 'ring' || site.kind === 'anomaly')) {
        if (world.sim(def.id).asteroids(site.id).length > 0) field = { def, site };
      }
    }
  }
  expect(port, 'the test sector has a station or outpost').toBeTruthy();
  expect(field, 'the test sector has an asteroid field').toBeTruthy();
});

afterEach(() => {
  for (const sim of world.sims.values()) {
    for (const ship of [...sim.ships.values()]) sim.removeShip(ship);
    sim.objects.clear();
    const evs = spies.get(sim);
    if (evs) evs.length = 0;
  }
  for (const [def, level] of securityBefore) def.security = level;
  securityBefore.clear();
});

afterAll(async () => {
  await c.stop();
});

describe('weapons', () => {
  it('fires at the rate of the weapon and no faster', () => {
    const sim = arena(port, 'lawless');
    const evs = eventsOf(sim);
    const ship = place(sim, 'wisp', port.site.id, OPEN);
    // Two Pulse Laser I, four shots per second each.
    expect(ship.stats.weapons.map((w) => w.id)).toEqual(['pulse_1', 'pulse_1']);
    ship.stats = { ...ship.stats, energyMax: 1000 };
    ship.state.energy = 1000;
    ship.input.buttons = Button.Fire1;
    run(30);
    const mine = shots(evs, ship.id);
    expect(mine.filter((s) => s.slot === 0)).toHaveLength(4);
    expect(mine.filter((s) => s.slot === 1)).toHaveLength(4);
    expect(ship.flags & EntityFlag.Firing).toBeTruthy();
    run(90);
    // Over four seconds the average rate is exact: 16 shots per mount.
    expect(shots(evs, ship.id).filter((s) => s.slot === 0)).toHaveLength(16);

    // The secondary trigger fires nothing on a ship without secondary weapons.
    evs.length = 0;
    ship.input.buttons = Button.Fire2;
    run(30);
    expect(shots(evs, ship.id)).toHaveLength(0);
    expect(ship.flags & EntityFlag.Firing).toBe(0);
  });

  it('spends energy, builds heat and stops when either runs out', () => {
    const sim = arena(port, 'lawless');
    const evs = eventsOf(sim);
    const firing = place(sim, 'wisp', port.site.id, OPEN);
    const idle = place(sim, 'wisp', port.site.id, [OPEN[0], 500, 0]);
    firing.input.buttons = Button.Fire1;
    run(15);
    expect(shots(evs, firing.id).length).toBeGreaterThan(0);
    expect(firing.state.energy).toBeLessThan(idle.state.energy);
    expect(firing.state.heat).toBeGreaterThan(idle.state.heat);

    // A flat reactor: one shot needs 2.6 energy.
    const flat = place(sim, 'wisp', port.site.id, [OPEN[0], 1000, 0]);
    flat.stats = { ...flat.stats, energyRegen: 0 };
    flat.state.energy = 2;
    flat.input.buttons = Button.Fire1;
    // A ship at its heat limit: one more shot would overheat it.
    const hot = place(sim, 'wisp', port.site.id, [OPEN[0], 1500, 0]);
    hot.stats = { ...hot.stats, cooling: 0 };
    hot.state.heat = hot.stats.heatCap - 0.5;
    hot.input.buttons = Button.Fire1;
    run(30);
    expect(shots(evs, flat.id)).toHaveLength(0);
    expect(flat.state.energy).toBe(2);
    expect(shots(evs, hot.id)).toHaveLength(0);
    expect(hot.flags & EntityFlag.Firing).toBe(0);
  });

  it('hits a locked target ahead and misses when the nose points away', () => {
    const sim = arena(port, 'lawless');
    const evs = eventsOf(sim);
    const target = place(sim, 'bulwark', port.site.id, ahead(OPEN, 800));
    expect(target.stats.shieldMax).toBeGreaterThan(50);
    const shooter = place(sim, 'wisp', port.site.id, OPEN);
    shooter.target = target.id;
    shooter.input.buttons = Button.Fire1;
    run(10);
    const fired = shots(evs, shooter.id);
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.every((s) => s.to === target.id)).toBe(true);
    // The impact point lies on the target's hull sphere.
    expect(v3.dist(fired[0]!.at, target.state.pos)).toBeCloseTo(target.stats.radius, 0);
    expect(hits(evs, target.id).every((h) => h.by === shooter.id && h.shield)).toBe(true);
    expect(target.state.shield).toBeLessThan(target.stats.shieldMax);
    expect(target.state.hull).toBe(target.stats.hullMax);
    expect(target.lastHitBy).toBe(shooter.id);

    // Same lock, nose turned a quarter turn away: far outside the gimbal.
    shooter.input.buttons = 0;
    run(1);
    const shieldBefore = target.state.shield;
    evs.length = 0;
    shooter.state.rot = quat.fromAxisAngle([0, 1, 0], Math.PI / 2);
    shooter.input.buttons = Button.Fire1;
    run(10);
    const wide = shots(evs, shooter.id);
    expect(wide.length).toBeGreaterThan(0);
    expect(wide.every((s) => s.to === undefined)).toBe(true);
    expect(v3.dist(wide[0]!.at, shooter.state.pos)).toBeGreaterThan(2900);
    expect(hits(evs, target.id)).toHaveLength(0);
    expect(target.state.shield).toBeGreaterThanOrEqual(shieldBefore);
  });

  it('an asteroid between shooter and target stops the shot', () => {
    const sim = arena(field, 'lawless');
    const evs = eventsOf(sim);
    const rocks = sim.asteroids(field.site.id);
    // A rock with free space in front of and behind it along Z.
    const clear = (p: Vec3) => rocks.every((r) => v3.dist(r.pos, p) > r.radius + 60);
    const rock = rocks.find((r) => r.radius >= 12 && clear([r.pos[0], r.pos[1], r.pos[2] + r.radius + 250]) && clear([r.pos[0], r.pos[1], r.pos[2] - r.radius - 250]));
    expect(rock, 'a rock with clear space on both sides').toBeTruthy();
    const from: Vec3 = [rock!.pos[0], rock!.pos[1], rock!.pos[2] + rock!.radius + 250];
    const behind: Vec3 = [rock!.pos[0], rock!.pos[1], rock!.pos[2] - rock!.radius - 250];
    const target = place(sim, 'bulwark', field.site.id, behind);
    const shooter = place(sim, 'drover', field.site.id, from);
    shooter.target = target.id;
    shooter.input.buttons = Button.Fire1;
    run(20);
    const fired = shots(evs, shooter.id);
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.every((s) => s.to === undefined)).toBe(true);
    // The beam ends on the surface of the rock.
    expect(v3.dist(fired[0]!.at, rock!.pos)).toBeCloseTo(rock!.radius, 0);
    expect(hits(evs, target.id)).toHaveLength(0);
    expect(target.state.shield).toBe(target.stats.shieldMax);
  });

  it('shields absorb before the hull, each with its multiplier', () => {
    const sim = arena(port, 'lawless');
    const target = place(sim, 'bulwark', port.site.id, ahead(OPEN, 600));
    // One Pulse Laser I: 13 damage, x1.25 against shields, x0.8 against hull.
    const shooter = place(sim, 'drover', port.site.id, OPEN);
    expect(shooter.stats.weapons).toHaveLength(1);
    shooter.target = target.id;
    const full = target.stats.shieldMax;
    shooter.input.buttons = Button.Fire1;
    run(1);
    shooter.input.buttons = 0;
    expect(target.state.shield).toBeCloseTo(full - 13 * 1.25, 6);
    expect(target.state.hull).toBe(target.stats.hullMax);

    // 10 shield points left take 8 damage; the remaining 5 reach the hull as 4.
    run(10);
    target.state.shield = 10;
    target.state.shieldDelay = 1e6;
    shooter.input.buttons = Button.Fire1;
    run(1);
    shooter.input.buttons = 0;
    expect(target.state.shield).toBe(0);
    expect(target.state.hull).toBeCloseTo(target.stats.hullMax - 4, 6);
  });

  it('a beam burns continuously and a cannon shell arrives after its flight time', () => {
    const sim = arena(port, 'lawless');
    const evs = eventsOf(sim);
    // Beam Laser I: 62 damage per second, x1.35 against shields.
    const fit = starterLoadout('wisp');
    fit.modules[0] = 'beam_1';
    fit.modules[1] = null;
    const beamer = place(sim, fit, port.site.id, OPEN);
    expect(beamer.stats.weapons.map((w) => w.kind)).toEqual(['beam']);
    beamer.stats = { ...beamer.stats, energyMax: 1000, energyRegen: 0, heatCap: 1000 };
    beamer.state.energy = 1000;
    const target = place(sim, 'bulwark', port.site.id, ahead(OPEN, 600));
    const full = target.stats.shieldMax;
    beamer.target = target.id;
    beamer.input.buttons = Button.Fire1;
    run(30);
    beamer.input.buttons = 0;
    expect(full - target.state.shield).toBeCloseTo(62 * 1.35, 3);
    // One second of beam costs 15 energy.
    expect(beamer.state.energy).toBeCloseTo(1000 - 15, 6);
    // One second of beam is reported as five shots and five hits, not thirty.
    expect(shots(evs, beamer.id)).toHaveLength(5);
    expect(hits(evs, target.id)).toHaveLength(5);

    // Autocannon I: 24 damage at 1900 m/s, x0.65 against shields. The target drifts sideways.
    sim.removeShip(beamer);
    evs.length = 0;
    const gunner = place(sim, 'lancet', port.site.id, [OPEN[0], 3000, 0]);
    const drifter = place(sim, 'bulwark', port.site.id, [OPEN[0], 3000, -1900]);
    drifter.input.buttons = Button.FaOff;
    drifter.state.vel = [40, 0, 0];
    gunner.target = drifter.id;
    run(1);
    const xAtShot = drifter.state.pos[0] + 40 * DT;
    gunner.input.buttons = Button.Fire2;
    run(1);
    gunner.input.buttons = 0;
    const shell = shots(evs, gunner.id);
    expect(shell).toHaveLength(1);
    expect(shell[0]).toMatchObject({ w: 'cannon_1', to: drifter.id });
    // The shell is aimed ahead of the target: about one second of drift.
    expect(shell[0]!.at[0] - xAtShot).toBeGreaterThan(25);
    expect(shell[0]!.at[0] - xAtShot).toBeLessThan(55);
    expect(pendingImpacts(sim)).toBe(1);
    run(24);
    expect(hits(evs, drifter.id)).toHaveLength(0);
    expect(drifter.state.shield).toBe(drifter.stats.shieldMax);
    run(10);
    expect(hits(evs, drifter.id)).toHaveLength(1);
    expect(drifter.stats.shieldMax - drifter.state.shield).toBeCloseTo(24 * 0.65, 6);
    expect(pendingImpacts(sim)).toBe(0);

    // A target that is no longer where the shell was sent is missed.
    evs.length = 0;
    gunner.input.buttons = Button.Fire2;
    run(1);
    gunner.input.buttons = 0;
    expect(shots(evs, gunner.id)).toHaveLength(1);
    drifter.state.pos[1] += 200;
    run(40);
    expect(hits(evs, drifter.id)).toHaveLength(0);
    expect(pendingImpacts(sim)).toBe(0);
  });

  it('a missile homes on a slow target and expires when it finds nothing', () => {
    const sim = arena(port, 'lawless');
    const evs = eventsOf(sim);
    // A gunship carrying nothing but its Seeker Rack.
    const fit = starterLoadout('bulwark');
    fit.modules = fit.modules.map((m) => (m && (m.startsWith('pulse') || m.startsWith('cannon')) ? null : m));
    const shooter = place(sim, fit, port.site.id, OPEN);
    expect(shooter.stats.weapons.map((w) => w.kind)).toEqual(['missile']);
    // The target sits off to one side and creeps along: the missile has to turn.
    const target = place(sim, 'drover', port.site.id, [OPEN[0] + 600, 200, OPEN[2] - 2500]);
    target.input.throttle = 0.3;
    shooter.target = target.id;
    shooter.input.buttons = Button.Fire2;
    run(1);
    shooter.input.buttons = 0;
    const missiles = () => [...sim.objects.values()].filter((o) => o.kind === EntityKind.Missile);
    expect(missiles()).toHaveLength(1);
    expect(shots(evs, shooter.id)).toHaveLength(1);
    const before = target.state.shield + target.state.hull;
    let ticks = 0;
    while (missiles().length > 0 && ticks < 14 * 30 + 10) {
      run(1);
      ticks++;
    }
    expect(hits(evs, target.id)).toHaveLength(1);
    expect(hits(evs, target.id)[0]!.by).toBe(shooter.id);
    expect(target.state.shield + target.state.hull).toBeLessThan(before);
    expect(ticks).toBeLessThan(10 * 30);

    // No lock: the next missile flies straight until its motor burns out.
    evs.length = 0;
    shooter.target = null;
    shooter.state.rot = quat.fromAxisAngle([0, 1, 0], Math.PI);
    run(120);
    shooter.input.buttons = Button.Fire2;
    run(1);
    shooter.input.buttons = 0;
    expect(missiles()).toHaveLength(1);
    run(13 * 30);
    expect(missiles()).toHaveLength(1);
    run(2 * 30);
    expect(missiles()).toHaveLength(0);
    expect(evs.filter((e) => e.e === 'hit')).toHaveLength(0);
  });

  it('weapons stay locked next to a station in a secure system', () => {
    const sim = arena(port, 'secure');
    const evs = eventsOf(sim);
    const near: Vec3 = [MASS_LOCK_RADIUS - 500, 0, 0];
    const me = pilot(sim, 'wisp', port.site.id, near);
    const target = place(sim, 'bulwark', port.site.id, ahead(near, 500));
    me.ship.target = target.id;
    me.ship.input.buttons = Button.Fire1;
    run(60);
    expect(shots(evs, me.ship.id)).toHaveLength(0);
    expect(me.ship.flags & EntityFlag.Firing).toBe(0);
    expect(target.state.shield).toBe(target.stats.shieldMax);
    // The pilot is told why, but not on every tick.
    expect(me.notices.filter((n) => n.code === 'weapons_locked')).toHaveLength(1);
    run(120);
    expect(me.notices.filter((n) => n.code === 'weapons_locked')).toHaveLength(2);

    // The same spot in a frontier system is free-fire.
    setSecurity(sim, 'frontier');
    run(10);
    expect(shots(evs, me.ship.id).length).toBeGreaterThan(0);
    expect(target.state.shield).toBeLessThan(target.stats.shieldMax);
  });

  it('docked ships cannot be shot or damaged', () => {
    const sim = arena(port, 'lawless');
    const evs = eventsOf(sim);
    const docked = place(sim, 'drover', port.site.id, ahead(OPEN, 400));
    docked.state.mode = FlightMode.Docked;
    const shooter = place(sim, 'wisp', port.site.id, OPEN);
    shooter.target = docked.id;
    shooter.input.buttons = Button.Fire1;
    run(15);
    expect(shots(evs, shooter.id).length).toBeGreaterThan(0);
    expect(shots(evs, shooter.id).every((s) => s.to === undefined)).toBe(true);
    sim.damage(docked, 500, { by: shooter });
    expect(docked.state.hull).toBe(docked.stats.hullMax);
    expect(docked.state.shield).toBe(docked.stats.shieldMax);
    expect(docked.gone).toBe(false);
  });
});

describe('law', () => {
  it('secure space: assault makes wanted, murder costs more, and the bounty pays out', () => {
    const sim = arena(port, 'secure');
    const victim = pilot(sim, 'wisp', port.site.id, ahead(OPEN, 600));
    const attacker = pilot(sim, 'wisp', port.site.id, OPEN);
    harden(victim.ship);
    run(31);
    expect(attacker.ship.wanted).toBe(false);
    attacker.ship.target = victim.ship.id;
    attacker.ship.input.buttons = Button.Fire1;
    run(2);
    expect(law(attacker)).toMatchObject({ bounty: 400 });
    expect(law(attacker)!.wantedUntil).toBeGreaterThan(sim.time + 590);
    expect(attacker.ship.wanted).toBe(true);
    expect(attacker.notices.some((n) => n.code === 'wanted')).toBe(true);
    // A long burst is still one assault.
    run(60);
    expect(law(attacker)!.bounty).toBe(400);

    weaken(victim.ship);
    run(10);
    expect(victim.ship.state.mode).toBe(FlightMode.Dead);
    expect(law(attacker)!.bounty).toBe(5400);
    expect(attacker.p.rec.passport.stats.kills).toBe(1);
    expect(world.pilotView(attacker.p)).toMatchObject({ bounty: 5400, wanted: true });
    expect(world.pilotView(victim.p)).toMatchObject({ bounty: 0, wanted: false });
    // The deductible is charged when the victim respawns (insurance module), not at the kill.
    expect(victim.p.rec.credits).toBe(10_000);

    // A bounty hunter may now destroy the attacker without penalty and collects.
    attacker.ship.input.buttons = 0;
    const hunter = pilot(sim, 'lancet', port.site.id, [OPEN[0], 0, 600]);
    hunter.ship.target = attacker.ship.id;
    hunter.ship.input.buttons = Button.Fire1;
    weaken(attacker.ship);
    run(10);
    expect(attacker.ship.state.mode).toBe(FlightMode.Dead);
    expect(hunter.p.rec.credits).toBe(10_000 + 5_400);
    expect(hunter.p.rec.passport.stats.kills).toBe(1);
    expect(hunter.ship.wanted).toBe(false);
    expect(law(hunter)?.bounty ?? 0).toBe(0);
    expect(law(attacker)).toMatchObject({ bounty: 0, wantedUntil: 0 });
    expect(attacker.ship.wanted).toBe(false);
    expect(attacker.p.rec.credits).toBe(10_000 - 2_750);
  });

  it('destroying a pirate is no crime anywhere and pays its bounty', () => {
    const sim = arena(port, 'secure');
    const hunter = pilot(sim, 'lancet', port.site.id, OPEN);
    // The NPC module is switched off here, so the pirate just sits there.
    const pirate = spawnNpc(sim, port.site.id, 'pirate', ahead(OPEN, 700));
    const bounty = (pirate.brain as { bounty: number }).bounty;
    expect(bounty).toBeGreaterThanOrEqual(300);
    expect(pirate.wanted).toBe(true);
    hunter.ship.target = pirate.id;
    hunter.ship.input.buttons = Button.Fire1;
    run(5);
    expect(pirate.lastHitBy).toBe(hunter.ship.id);
    weaken(pirate);
    run(10);
    expect(pirate.gone).toBe(true);
    expect(hunter.p.rec.credits).toBe(10_000 + bounty);
    expect(hunter.p.rec.passport.stats.kills).toBe(1);
    expect(hunter.ship.wanted).toBe(false);
    expect(world.pilotView(hunter.p)).toMatchObject({ bounty: 0, wanted: false, credits: 10_000 + bounty });
    expect(hunter.notices.some((n) => n.code === 'bounty_paid')).toBe(true);
  });

  it('the wanted status lapses after ten minutes', () => {
    const sim = arena(port, 'secure');
    const victim = place(sim, 'bulwark', port.site.id, ahead(OPEN, 600));
    const attacker = pilot(sim, 'wisp', port.site.id, OPEN);
    attacker.ship.target = victim.id;
    attacker.ship.input.buttons = Button.Fire1;
    run(3);
    attacker.ship.input.buttons = 0;
    expect(attacker.ship.wanted).toBe(true);
    c.nowMs += 601_000;
    run(31);
    expect(attacker.ship.wanted).toBe(false);
    expect(world.pilotView(attacker.p)).toMatchObject({ bounty: 400, wanted: false });
  });

  it('frontier space: only the kill counts, and self-defence is no crime', () => {
    const sim = arena(port, 'frontier');
    const victim = pilot(sim, 'wisp', port.site.id, ahead(OPEN, 600));
    const attacker = pilot(sim, 'wisp', port.site.id, OPEN);
    harden(victim.ship);
    attacker.ship.target = victim.ship.id;
    attacker.ship.input.buttons = Button.Fire1;
    run(40);
    expect(victim.ship.lastHitBy).toBe(attacker.ship.id);
    expect(law(attacker)?.bounty ?? 0).toBe(0);
    expect(attacker.ship.wanted).toBe(false);

    // The victim shoots back and destroys the aggressor: no bounty for defending oneself.
    attacker.ship.input.buttons = 0;
    victim.ship.state.rot = quat.fromAxisAngle([0, 1, 0], Math.PI);
    victim.ship.target = attacker.ship.id;
    victim.ship.input.buttons = Button.Fire1;
    weaken(attacker.ship);
    run(10);
    expect(attacker.ship.state.mode).toBe(FlightMode.Dead);
    expect(law(victim)?.bounty ?? 0).toBe(0);
    expect(victim.ship.wanted).toBe(false);

    // An unprovoked kill puts 2500 cr on the killer's head.
    victim.ship.input.buttons = 0;
    const bystander = place(sim, 'drover', port.site.id, [OPEN[0], 0, OPEN[2] - 600 + 500]);
    victim.ship.target = bystander.id;
    weaken(bystander);
    victim.ship.input.buttons = Button.Fire1;
    run(10);
    expect(bystander.gone).toBe(true);
    expect(law(victim)).toMatchObject({ bounty: 2500 });
    expect(victim.ship.wanted).toBe(true);
  });

  it('lawless space: nobody keeps score', () => {
    const sim = arena(port, 'lawless');
    const victim = pilot(sim, 'wisp', port.site.id, ahead(OPEN, 600));
    const attacker = pilot(sim, 'wisp', port.site.id, OPEN);
    attacker.ship.target = victim.ship.id;
    attacker.ship.input.buttons = Button.Fire1;
    weaken(victim.ship);
    run(40);
    expect(victim.ship.state.mode).toBe(FlightMode.Dead);
    expect(law(attacker)?.bounty ?? 0).toBe(0);
    expect(attacker.ship.wanted).toBe(false);
    expect(world.pilotView(attacker.p)).toMatchObject({ bounty: 0, wanted: false });
    expect(attacker.p.rec.passport.stats.kills).toBe(1);
  });
});

describe('destruction', () => {
  it('leaves a wreck holding the whole cargo instead of loose pods', () => {
    const sim = arena(port, 'lawless');
    const wrecks = () => [...sim.objects.values()].filter((o) => o.kind === EntityKind.Wreck);
    const hauler = place(sim, 'drover', port.site.id, OPEN);
    hauler.cargo = [
      { c: 'food', n: 10, origin: world.id },
      { c: 'alloys', n: 5, origin: 'elsewhere' },
      { c: 'not-a-commodity', n: 40, origin: world.id },
    ];
    run(1);
    sim.destroy(hauler, null);
    expect(hauler.gone).toBe(true);
    expect([...sim.objects.values()].filter((o) => o.kind === EntityKind.Loot)).toHaveLength(0);
    expect(wrecks()).toHaveLength(1);
    const data = wrecks()[0]!.data as { contents: { c: string; n: number; origin: string }[] };
    expect(data.contents).toContainEqual({ c: 'food', n: 10, origin: world.id });
    expect(data.contents).toContainEqual({ c: 'alloys', n: 5, origin: 'elsewhere' });
    expect(data.contents.some((it) => it.c === 'not-a-commodity')).toBe(false);

    // Destruction takes no credits; the deductible is charged on respawn.
    const broke = pilot(sim, 'wisp', port.site.id, [OPEN[0], 4000, 0], 120);
    sim.destroy(broke.ship, null);
    expect(broke.p.rec.credits).toBe(120);
  });
});

/** Far beyond sensor and weapon reach of anything near the centre of a site. */
const FAR: Vec3 = [0, 60_000, 0];

/**
 * The simulation of a system at a given security level, with a pilot parked far from the action:
 * the world drops simulations that have had no pilot for a while.
 */
function arena(where: { def: SystemDef; site: SiteDef }, level: Security): SystemSim {
  const sim = world.sim(where.def.id);
  setSecurity(sim, level);
  pilot(sim, 'wisp', where.site.id, FAR);
  return sim;
}

describe('npcs', () => {
  beforeAll(() => {
    world.modules.splice(npcIndex, 0, npcModule);
  });

  afterAll(() => {
    world.modules.splice(world.modules.indexOf(npcModule), 1);
  });

  const npcsIn = (sim: SystemSim, zone?: number): Ship[] =>
    [...sim.ships.values()].filter((s) => s.npc !== null && (zone === undefined || s.state.anchor === zone));
  const populated = (s: SiteDef) => ['station', 'outpost', 'belt', 'ring', 'anomaly'].includes(s.kind);

  /** Runs `ticks` ticks and returns the milliseconds per tick the NPC module spent steering. */
  function npcCost(ticks: number): number {
    let spent = 0;
    const preStep = npcModule.preStep!;
    npcModule.preStep = (s, t, dt) => {
      const start = performance.now();
      preStep(s, t, dt);
      spent += performance.now() - start;
    };
    try {
      run(ticks);
    } finally {
      npcModule.preStep = preStep;
    }
    return spent / ticks;
  }

  it('appear only where a pilot is and leave a minute after the pilot has gone', () => {
    const sim = world.sim(field.def.id);
    setSecurity(sim, 'frontier');
    const others = field.def.sites.filter((s) => s.id !== field.site.id);
    const other = others.find(populated) ?? others[0];
    expect(other, 'the system has a second site').toBeTruthy();
    const me = pilot(sim, 'wisp', field.site.id, FAR);
    const evs = eventsOf(sim);
    // Flying among asteroids (the costly case: every decision scans the rocks) stays cheap.
    expect(npcCost(10 * 30)).toBeLessThan(0.25);
    // A frontier field holds two miners and two pirates.
    const here = npcsIn(sim, field.site.id);
    const locals = new Set(here.map((s) => s.id));
    expect(here.map((s) => s.npc).sort()).toEqual(['miner', 'miner', 'pirate', 'pirate']);
    expect(npcsIn(sim)).toHaveLength(4);
    for (const ship of here) {
      expect(v3.len(ship.state.pos)).toBeGreaterThan(1_000);
      expect(v3.len(ship.state.pos)).toBeLessThan(16_000);
      expect(ship.faction).toBeTruthy();
      if (ship.npc === 'miner') {
        expect(ship.stats.hull).toBe('delver');
        expect(ship.cargo.length).toBeGreaterThan(0);
        expect(ship.wanted).toBe(false);
      } else {
        expect(['wisp', 'lancet']).toContain(ship.stats.hull);
        expect(ship.wanted).toBe(true);
        expect((ship.brain as { bounty: number }).bounty).toBeGreaterThan(0);
      }
    }

    // The pilot moves to another site: traffic appears there and the field empties after a minute.
    me.ship.state.anchor = other!.id;
    run(30 * 30);
    expect(npcsIn(sim, field.site.id).length).toBeGreaterThanOrEqual(3);
    // Nobody fights in the field, so any hit on these ships would be a collision with a rock.
    expect(evs.filter((e) => e.e === 'hit' && locals.has(e.id))).toHaveLength(0);
    if (populated(other!)) expect(npcsIn(sim, other!.id).length).toBeGreaterThan(0);
    run(32 * 30);
    expect(npcsIn(sim, field.site.id)).toHaveLength(0);
    expect(npcsIn(sim).every((s) => s.state.anchor === other!.id)).toBe(true);
    expect(world.sims.get(field.def.id)).toBe(sim);
  });

  it('respect the caps of 8 per zone and 24 per system, and fly cheaply', () => {
    const sim = world.sim(port.def.id);
    setSecurity(sim, 'secure');
    const zone = port.site.id;
    pilot(sim, 'wisp', zone, FAR);
    // A secure station wants three traders and two patrols, but the zone is already full.
    for (let i = 0; i < 8; i++) spawnNpc(sim, zone, 'miner');
    // Eight NPCs must cost well under half a millisecond per tick.
    expect(npcCost(10 * 30)).toBeLessThan(0.25);
    expect(npcsIn(sim, zone)).toHaveLength(8);
    expect(npcsIn(sim).every((s) => s.npc === 'miner')).toBe(true);

    // With 24 NPCs in the system nothing more is added, even in a zone that has none.
    const second = port.def.sites.find((s) => s.id !== zone && populated(s));
    expect(second, 'the system has a second populated site').toBeTruthy();
    for (let i = 0; i < 16; i++) spawnNpc(sim, zone, 'miner');
    pilot(sim, 'wisp', second!.id, FAR);
    run(5 * 30);
    expect(npcsIn(sim)).toHaveLength(24);
    expect(npcsIn(sim, second!.id)).toHaveLength(0);

    // Slots come free: the second zone fills, and neither cap is ever exceeded.
    for (const ship of npcsIn(sim, zone).slice(0, 14)) sim.removeShip(ship);
    run(10 * 30);
    expect(npcsIn(sim, second!.id).length).toBeGreaterThan(0);
    expect(npcsIn(sim, second!.id).length).toBeLessThanOrEqual(8);
    expect(npcsIn(sim, zone)).toHaveLength(10);
    expect(npcsIn(sim).length).toBeLessThanOrEqual(24);
  });

  it('pirates hunt a laden pilot and traders run from an attacker', () => {
    const sim = world.sim(port.def.id);
    setSecurity(sim, 'lawless');
    const evs = eventsOf(sim);
    const zone = port.site.id;
    const me = pilot(sim, 'drover', zone, [7_000, 0, 0]);
    me.p.addCargo('food', 10, world.id);
    harden(me.ship);
    const pirate = spawnNpc(sim, zone, 'pirate', [7_000, 0, -2_500]);
    run(30 * 30);
    expect(pirate.target).toBe(me.ship.id);
    expect(hits(evs, me.ship.id).some((h) => h.by === pirate.id)).toBe(true);
    expect(v3.dist(pirate.state.pos, me.ship.state.pos)).toBeLessThan(2_500);

    // The pilot shoots a passing trader: it turns tail and opens the distance. (Secure space,
    // so no pirate turns up and chases the trader somewhere else.)
    for (const ship of npcsIn(sim)) sim.removeShip(ship);
    setSecurity(sim, 'secure');
    const trader = spawnNpc(sim, zone, 'trader', [7_000, 0, -900]);
    harden(trader);
    me.ship.target = trader.id;
    me.ship.input.buttons = Button.Fire1;
    run(15);
    me.ship.input.buttons = 0;
    expect(trader.lastHitBy).toBe(me.ship.id);
    run(15 * 30);
    expect(v3.dist(trader.state.pos, me.ship.state.pos)).toBeGreaterThan(2_000);
  });

  it('a pirate and a patrol fight for 90 seconds without the simulation going wrong', () => {
    const sim = world.sim(port.def.id);
    setSecurity(sim, 'frontier');
    const evs = eventsOf(sim);
    const zone = port.site.id;
    pilot(sim, 'wisp', zone, FAR);
    const pirate = spawnNpc(sim, zone, 'pirate', [6_000, 0, 0]);
    const patrol = spawnNpc(sim, zone, 'security', [6_000, 0, -2_500]);
    const duelists = new Set([pirate.id, patrol.id]);
    let fastest = 0;
    let closest = Infinity;
    for (let i = 0; i < 90 * 30; i++) {
      run(1);
      for (const ship of sim.ships.values()) {
        const s = ship.state;
        if (!v3.isFinite(s.pos) || !v3.isFinite(s.vel) || !quat.isFinite(s.rot) || !Number.isFinite(s.hull + s.shield + s.energy + s.heat)) {
          throw new Error(`${ship.name} has a non-finite state at tick ${i}`);
        }
        fastest = Math.max(fastest, v3.len(s.vel));
        if (ship.npc) closest = Math.min(closest, v3.len(s.pos));
      }
    }
    // Nothing outruns a boosting fighter, and nobody flew into the station.
    expect(fastest).toBeLessThan(500);
    expect(closest).toBeGreaterThan(800);
    // It was a real fight, whoever won it: shots were fired and landed between the two.
    expect(evs.filter((e) => e.e === 'shot' && duelists.has(e.from)).length).toBeGreaterThan(10);
    expect(evs.filter((e) => e.e === 'hit' && e.by !== undefined && duelists.has(e.by) && duelists.has(e.id)).length).toBeGreaterThan(3);
    for (const ship of npcsIn(sim)) expect(v3.len(ship.state.pos)).toBeLessThan(20_000);
    expect(world.sims.get(port.def.id)).toBe(sim);
  });
});
