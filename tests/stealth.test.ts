/**
 * Power distribution, silent running and detection on the server: a real world on a manually
 * advanced clock, with ships placed directly into the simulation so every distance is exact.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Button,
  DEFAULT_PIPS,
  DETECT_HYSTERESIS,
  DT,
  EntityKind,
  VISUAL_RANGE,
  computeShipStats,
  decodeSnapshot,
  detectionRange,
  newPassport,
  newShipState,
  packPips,
  starterLoadout,
  v3,
  type Loadout,
  type S2C,
  type ShipInput,
  type SiteDef,
  type Snapshot,
  type SystemDef,
  type Vec3,
} from '@primacy2/shared';
import { Player, newShip, type GameModule, type PlayerRecord, type PrimacyServer, type Ship, type SystemSim, type World } from '@primacy2/server';
import { Cluster } from './harness.ts';
import { spawnNpc, type NpcBrain } from '../packages/server/src/modules/npc.ts';
import { LOSE_TARGET_AFTER } from '../packages/server/src/modules/npc/ai.ts';
import { parseClientMessage } from '../packages/server/src/validate.ts';

const c = new Cluster();
let S: PrimacyServer;
let world: World;
let npcModule: GameModule;
let npcIndex = -1;
let port: { def: SystemDef; site: SiteDef };
let sim: SystemSim;
/** Anchor id of the zone most tests use: the surroundings of a station or outpost. */
let zone = -1;
let pilots = 0;
let seq = 0;

/** A spot well away from the station, and one far outside anyone's sensors. */
const OPEN: Vec3 = [20_000, 0, 0];
const FAR: Vec3 = [60_000, 0, 0];
const ahead = (p: Vec3, metres: number): Vec3 => [p[0], p[1], p[2] - metres];

/** Advances the server synchronously: no sockets are involved in these tests. */
function run(ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    c.nowMs += DT * 1000;
    S.tick();
  }
}

/** Runs until `pred` holds, at most `seconds` of simulated time. Returns whether it did. */
function until(pred: () => boolean, seconds: number): boolean {
  for (let i = 0; i < seconds / DT && !pred(); i++) run(1);
  return pred();
}

/** Places an unmanned ship at rest, nose toward -Z. */
function place(fit: string | Loadout, pos: Vec3, name = 'Drone', at = zone): Ship {
  const loadout = typeof fit === 'string' ? starterLoadout(fit) : fit;
  const stats = computeShipStats(loadout);
  const state = newShipState(stats);
  state.anchor = at;
  state.pos = v3.clone(pos);
  const ship = newShip(world.allocId(), name, loadout, stats, state);
  sim.addShip(ship);
  return ship;
}

interface TestPilot {
  ship: Ship;
  p: Player;
  /** Entity ids announced with `ent+` and withdrawn with `ent-`, in order of arrival. */
  added: number[];
  removed: number[];
  /** The most recent snapshot this pilot's client received. */
  last: Snapshot | null;
}

/** Places a ship flown by a pilot whose connection records what the server sends it. */
function pilot(hull: string, pos: Vec3): TestPilot {
  const id = `stealth-pilot-${++pilots}`;
  const passport = newPassport(id, `Pilot ${pilots}`, world.id);
  passport.ship.loadout = starterLoadout(hull);
  const rec: PlayerRecord = {
    id, key: id, passport, credits: 0, status: 'here', system: sim.def.id, ship: null,
    homeSystem: null, homeSite: null, data: {}, createdAt: 0, updatedAt: 0,
  };
  const p = new Player(rec);
  const ship = place(passport.ship.loadout, pos, p.name);
  const t: TestPilot = { ship, p, added: [], removed: [], last: null };
  p.conn = {
    send(text) {
      const m = JSON.parse(text) as S2C;
      if (m.t === 'ent+') t.added.push(...m.e.map((e) => e.id));
      else if (m.t === 'ent-') t.removed.push(...m.ids);
    },
    sendBinary(data) {
      t.last = decodeSnapshot(data);
    },
    close() {},
  };
  ship.player = p;
  ship.cargo = passport.ship.cargo;
  p.ship = ship;
  p.sim = sim;
  sim.addShip(ship);
  return t;
}

/** Queues one input for a pilot, as its client would send it; the server keeps it held afterwards. */
function send(t: TestPilot, over: Partial<ShipInput>): void {
  t.p.inputs.push({ seq: ++seq, thrust: [0, 0, 0], aim: [0, 0], roll: 0, throttle: 0, buttons: 0, ...over });
}

const contacts = (t: TestPilot): number[] => (t.last?.ents ?? []).map((e) => e.id);
const isField = (s: SiteDef): boolean => s.kind === 'belt' || s.kind === 'ring' || s.kind === 'anomaly';

beforeAll(async () => {
  S = await c.start({ name: 'Stealth', seed: 'stealth' });
  world = S.world;
  // The NPC module is put back only for the test that needs it.
  npcIndex = world.modules.findIndex((m) => m.name === 'npc');
  npcModule = world.modules[npcIndex]!;
  world.modules.splice(npcIndex, 1);
  for (const def of world.defs.values()) {
    for (const site of def.sites) if (!port && (site.kind === 'station' || site.kind === 'outpost')) port = { def, site };
  }
  expect(port, 'the test sector has a station or outpost').toBeTruthy();
  sim = world.sim(port.def.id);
  // Lawless space: no weapons lock, no patrol response.
  sim.def.security = 'lawless';
  zone = port.site.id;
});

beforeEach(() => {
  // A simulation without any pilot is put to sleep; this one keeps it running and sees nothing.
  pilot('wisp', FAR);
});

afterEach(() => {
  for (const s of world.sims.values()) {
    for (const ship of [...s.ships.values()]) s.removeShip(ship);
    s.objects.clear();
  }
  world.wings.clear();
});

afterAll(async () => {
  await c.stop();
});

describe('power distribution on the server', () => {
  it('reproduces a fight recorded before it existed, exactly, at the default setting', () => {
    // Numbers recorded from the unmodified server: a Lancet firing both groups at a Bulwark
    // 800 m ahead for 45 ticks.
    for (const pips of [undefined, DEFAULT_PIPS]) {
      const y = pips === undefined ? 0 : 5_000;
      const shooter = place('lancet', [OPEN[0], y, 0]);
      const target = place('bulwark', ahead([OPEN[0], y, 0], 800));
      if (pips !== undefined) shooter.input.pips = target.input.pips = pips;
      shooter.target = target.id;
      shooter.input.buttons = Button.Fire1 | Button.Fire2;
      run(45);
      expect(target.stats.shieldMax).toBe(960);
      expect(shooter.state.energy).toBe(134.53333333333353);
      expect(target.state.shield).toBe(671.3999999999999);
      expect(target.state.hull).toBe(1360);
      expect(shooter.state.pips).toBe(DEFAULT_PIPS);
    }
  });

  it('WEP makes shots cheaper or dearer', () => {
    for (const [wep, mul] of [[0, 1.3], [4, 1], [8, 0.7]] as const) {
      const ship = place('wisp', [OPEN[0], wep * 100, 0]);
      expect(ship.stats.weapons.map((w) => w.id)).toEqual(['pulse_1', 'pulse_1']);
      ship.stats = { ...ship.stats, energyRegen: 0 };
      ship.state.energy = 50;
      ship.input.pips = packPips(6 - wep / 2, 6 - wep / 2, wep);
      ship.input.buttons = Button.Fire1;
      // One tick: each of the two Pulse Laser I fires once, 2.6 energy per shot at the default.
      run(1);
      expect(ship.state.pips).toBe(ship.input.pips);
      expect(50 - ship.state.energy).toBeCloseTo(2 * 2.6 * mul, 9);
    }
  });

  it('SYS hardens or softens the shields', () => {
    for (const [sys, mul] of [[0, 1.15], [4, 1], [8, 0.85]] as const) {
      const ship = place('bulwark', [OPEN[0], sys * 200, 0]);
      ship.input.pips = packPips(sys, 6 - sys / 2, 6 - sys / 2);
      run(1);
      const full = ship.state.shield;
      sim.damage(ship, 100);
      expect(full - ship.state.shield).toBeCloseTo(100 * mul, 9);
      // On top of the weapon's own shield factor.
      sim.damage(ship, 100, { shieldMul: 1.25 });
      expect(full - ship.state.shield).toBeCloseTo(225 * mul, 9);
      expect(ship.state.hull).toBe(ship.stats.hullMax);

      // What the shields cannot absorb reaches the hull at face value.
      ship.state.shield = 50;
      sim.damage(ship, 100);
      expect(ship.state.shield).toBe(0);
      expect(ship.stats.hullMax - ship.state.hull).toBeCloseTo(100 - 50 / mul, 9);
    }
  });

  it('validates the setting that arrives with an input', () => {
    const parse = (i: object) =>
      parseClientMessage(JSON.stringify({ t: 'in', i: { seq: 7, thrust: [0, 0, 1], aim: [0, 0], roll: 0, throttle: 0, buttons: 0, ...i } }));
    expect(parse({ pips: packPips(8, 2, 2), buttons: Button.Silent })).toEqual({
      t: 'in', i: { seq: 7, thrust: [0, 0, 1], aim: [0, 0], roll: 0, throttle: 0, buttons: Button.Silent, pips: packPips(8, 2, 2) },
    });
    // Missing or invalid: the input still counts, with the default setting.
    for (const bad of [undefined, null, 'x', 1.5, -1, 0, 99_999, packPips(9, 3, 0), packPips(4, 4, 5), [1092], { sys: 4 }]) {
      const m = parse(bad === undefined ? {} : { pips: bad });
      expect(m, JSON.stringify(bad)).not.toBeNull();
      expect(m && m.t === 'in' && m.i.pips, JSON.stringify(bad)).toBe(DEFAULT_PIPS);
    }
  });
});

describe('silent running on the server', () => {
  it('cooks a ship that stays dark too long', () => {
    const dark = place('wisp', OPEN, 'Dark');
    const open = place('wisp', [OPEN[0], 2_000, 0], 'Open');
    dark.input.buttons = Button.Silent;
    run(20 / DT);
    expect(dark.state.shield).toBe(0);
    expect(dark.state.heat).toBeGreaterThan(20);
    expect(dark.state.heat).toBeLessThan(dark.stats.heatCap);
    expect(dark.state.hull).toBe(dark.stats.hullMax);
    expect(open.state.heat).toBe(0);
    expect(open.state.shield).toBe(open.stats.shieldMax);

    // The hull starts to suffer once the stored heat passes the heat capacity ...
    expect(until(() => dark.state.hull < dark.stats.hullMax, 120)).toBe(true);
    expect(dark.state.heat).toBeGreaterThan(dark.stats.heatCap);
    expect(dark.gone).toBe(false);
    // ... and the ship is lost if the radiators stay closed.
    expect(until(() => dark.gone, 120)).toBe(true);
    expect(open.gone).toBe(false);
    expect(open.state.hull).toBe(open.stats.hullMax);
  });
});

describe('detection: what a client is told about', () => {
  it('drops a silent ship beyond visual range and shows it again when it lights its engines', () => {
    const a = pilot('wisp', OPEN);
    const b = pilot('wisp', ahead(OPEN, 4_000));
    const near = place('wisp', [OPEN[0] + 1_000, 0, 0], 'Near');
    near.input.buttons = Button.Silent;
    // A cargo pod as far out as B, but not close enough to any ship to be scooped up.
    const pod = sim.spawnLoot(zone, [OPEN[0], 3_000, -3_000], [0, 0, 0], 'iron_ore', 1);
    run(4);
    expect(a.p.known.has(b.ship.id)).toBe(true);
    expect(a.added).toContain(b.ship.id);
    expect(contacts(a)).toContain(b.ship.id);
    expect(contacts(a)).toContain(near.id);
    expect(contacts(a)).toContain(pod.id);
    // The pilot's own signature and power setting come with its own state.
    expect(a.last!.self!.sig).toBeGreaterThan(0.74);
    expect(a.last!.self!.sig).toBeLessThan(0.85);
    // (The snapshot may be one tick old, and the flight assist's small corrections vary per tick.)
    expect(a.last!.self!.sig).toBeCloseTo(a.ship.state.sig, 4);
    expect(a.last!.self!.pips).toBe(DEFAULT_PIPS);

    // B goes dark, through its input queue like a real client, with a power setting of its own.
    const pips = packPips(2, 8, 2);
    send(b, { buttons: Button.Silent, pips });
    run(4);
    expect(a.p.known.has(b.ship.id)).toBe(false);
    expect(a.removed).toContain(b.ship.id);
    expect(contacts(a)).not.toContain(b.ship.id);
    expect(b.last!.self!.pips).toBe(pips);
    expect(b.last!.self!.sig).toBeLessThan(0.1);
    expect(b.last!.ackSeq).toBe(seq);
    // A dark ship still sees; a silent ship within visual range is still seen; cargo pods always are.
    expect(contacts(b)).toContain(a.ship.id);
    expect(v3.dist(near.state.pos, a.ship.state.pos)).toBeLessThan(VISUAL_RANGE);
    expect(contacts(a)).toContain(near.id);
    expect(contacts(a)).toContain(pod.id);

    // Still silent, B lights its engines: the flare shows from here.
    a.added.length = 0;
    send(b, { buttons: Button.Silent, thrust: [0, 0, 1], pips });
    run(4);
    expect(a.p.known.has(b.ship.id)).toBe(true);
    expect(a.added).toContain(b.ship.id);
    expect(contacts(a)).toContain(b.ship.id);

    // Engines off and coasting (flight assist would brake with the thrusters): dark again.
    a.removed.length = 0;
    send(b, { buttons: Button.Silent | Button.FaOff, pips });
    run(4);
    expect(a.removed).toContain(b.ship.id);
    expect(contacts(a)).not.toContain(b.ship.id);

    // Members of the same wing always see each other.
    world.wings.set(a.p.id, 'wing-1');
    world.wings.set(b.p.id, 'wing-1');
    run(2);
    expect(contacts(a)).toContain(b.ship.id);
    expect(sim.detects(a.ship, b.ship)).toBe(true);
    world.wings.set(b.p.id, 'wing-2');
    run(2);
    expect(contacts(a)).not.toContain(b.ship.id);
    expect(sim.detects(a.ship, b.ship)).toBe(false);
  });

  it('holds a contact at the edge of sensor range without flicker', () => {
    const a = pilot('wisp', OPEN);
    const drone = place('wisp', ahead(OPEN, 9_000));
    run(2);
    const range = detectionRange(a.ship.stats, drone.state.sig);
    expect(range).toBeGreaterThan(10_000);
    expect(range).toBeLessThan(11_000);
    const at = (factor: number): boolean => {
      drone.state.pos = ahead(a.ship.state.pos, range * factor);
      drone.state.vel = [0, 0, 0];
      run(2);
      return a.p.known.has(drone.id);
    };
    expect(at(1.2)).toBe(false);
    // Not picked up just outside the range, picked up just inside ...
    expect(at(1.04)).toBe(false);
    expect(at(0.96)).toBe(true);
    // ... then kept a little beyond it, and dropped past the margin.
    expect(at(1.04)).toBe(true);
    expect(DETECT_HYSTERESIS).toBeLessThan(1.15);
    expect(at(1.15)).toBe(false);
    expect(at(1.04)).toBe(false);
  });
});

describe('detection: NPCs and missiles', () => {
  it('an NPC loses a target that goes dark, and hunts it again when it shows itself', () => {
    // A quiet zone of its own, so that the usual traffic does not offer the raider other prey.
    const other = port.def.sites.find((s) => s.id !== port.site.id && !isField(s)) ?? port.def.sites.find((s) => s.id !== port.site.id);
    expect(other, 'the system has a second site').toBeTruthy();
    world.modules.splice(npcIndex, 0, npcModule);
    try {
      const hunter = spawnNpc(sim, other!.id, 'pirate', [6_000, 0, 0]);
      const brain = hunter.brain as NpcBrain;
      const prey = place('wisp', [6_000, 0, -6_000], 'Prey', other!.id);
      prey.npc = 'trader';
      expect(until(() => hunter.target === prey.id, 2)).toBe(true);
      expect(brain.mode).toBe('attack');

      // The prey closes its radiators and coasts away sideways.
      prey.state.vel = [120, 0, 0];
      prey.input.buttons = Button.Silent | Button.FaOff;
      run(2);
      const darkAt = sim.time;
      const lastSeen = v3.clone(prey.state.pos);
      expect(sim.detects(hunter, prey, true)).toBe(false);

      // For a few seconds the raider keeps heading for where it last saw the prey, guns silent.
      run(2 / DT);
      expect(hunter.target).toBe(prey.id);
      expect(v3.dist(brain.seenPos, lastSeen)).toBeLessThan(20);
      expect(v3.dist(prey.state.pos, lastSeen)).toBeGreaterThan(200);
      expect(hunter.input.buttons & (Button.Fire1 | Button.Fire2)).toBe(0);

      // Then it gives up.
      expect(until(() => hunter.target === null, 6)).toBe(true);
      expect(brain.mode).toBe('wander');
      expect(sim.time - darkAt).toBeGreaterThan(LOSE_TARGET_AFTER - 0.2);
      expect(sim.time - darkAt).toBeLessThan(LOSE_TARGET_AFTER + 0.4);

      // Radiators open again: the prey is back on the sensors and hunted once more.
      prey.input.buttons = Button.FaOff;
      expect(until(() => hunter.target === prey.id, 3)).toBe(true);
    } finally {
      world.modules.splice(world.modules.indexOf(npcModule), 1);
    }
  });

  it('a missile stops steering at a target that goes dark', () => {
    for (const dark of [false, true]) {
      const y = dark ? 4_000 : 0;
      const shooter = place('bulwark', [OPEN[0], y, 0]);
      const target = place('wisp', ahead([OPEN[0], y, 0], 6_000));
      shooter.target = target.id;
      shooter.input.buttons = Button.Fire2;
      run(1);
      shooter.input.buttons = 0;
      const missile = [...sim.objects.values()].find((o) => o.kind === EntityKind.Missile && (o.data as { from: number }).from === shooter.id)!;
      expect(missile).toBeTruthy();
      const seeker = missile.data as { target: number | null; tracking: boolean };
      expect(seeker.target).toBe(target.id);
      expect(seeker.tracking).toBe(true);

      // The target drifts off sideways, with or without closing its radiators first.
      target.input.buttons = dark ? Button.Silent | Button.FaOff : Button.FaOff;
      run(2);
      target.state.vel = [150, 0, 0];
      run(30);
      if (dark) {
        expect(seeker.tracking).toBe(false);
        expect(Math.abs(missile.vel[0])).toBeLessThan(1e-6);
      } else {
        expect(seeker.tracking).toBe(true);
        expect(missile.vel[0]).toBeGreaterThan(5);
      }
    }

    // A target that is already dark when the trigger is pulled gives no lock at all.
    const shooter = place('bulwark', [OPEN[0], 8_000, 0]);
    const target = place('wisp', ahead([OPEN[0], 8_000, 0], 6_000));
    target.input.buttons = Button.Silent;
    run(2);
    shooter.target = target.id;
    shooter.input.buttons = Button.Fire2;
    run(1);
    const blind = [...sim.objects.values()].find((o) => o.kind === EntityKind.Missile && (o.data as { from: number }).from === shooter.id)!;
    expect(blind).toBeTruthy();
    expect((blind.data as { target: number | null }).target).toBeNull();
  });
});
