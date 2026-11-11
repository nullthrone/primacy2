import { describe, expect, it } from 'vitest';
import { computeShipStats, starterLoadout } from '../catalog.ts';
import {
  CRUISE_MIN_SPEED,
  CRUISE_SAFE_DROP_SPEED,
  EARTH_RADIUS,
  FOLD_ARRIVAL_MIN,
  FOLD_ARRIVAL_RADII,
  FOLD_FUEL_BASE,
  FOLD_FUEL_PER_LY,
  MASS_LOCK_RADIUS,
  SOLAR_RADIUS,
  TIDAL_DAMAGE_THRESHOLD,
} from '../constants.ts';
import { forwardOf, quat, v3, type Vec3 } from '../math.ts';
import { Rng } from '../prng.ts';
import { anchorState } from '../universe/orbits.ts';
import {
  blackHoleSystem,
  FIXTURE_BEACON,
  FIXTURE_BH_RS,
  FIXTURE_PLANET,
  FIXTURE_STAR,
  FIXTURE_STATION,
  FIXTURE_STATION_ORBIT,
  fixtureSystem,
} from './fixtures.ts';
import { buildStepEnv, gravityAt, hazardsAt, newShipState } from './ship.ts';
import {
  absolutePosition,
  canEngageCruise,
  CRUISE_EXIT_SPEED,
  disengageCruise,
  engageCruise,
  foldArrivalDistance,
  FOLD_ARRIVAL_MAX_GRAVITY,
  foldFuelCost,
  isMassLocked,
  placeAtFoldArrival,
  placeAtSite,
  reanchor,
} from './transitions.ts';
import { ChargeKind, FlightMode, type ShipState } from './types.ts';

const wisp = computeShipStats(starterLoadout('wisp'));
const T = 12_345.6;

/** A ship in normal flight near the fixture station, moving and tilted. */
function shipAtStation(offset: Vec3 = [10_000, -300, 50]): ShipState {
  const s = newShipState(wisp);
  s.anchor = FIXTURE_STATION;
  s.pos = v3.clone(offset);
  s.vel = [10, 2, -3];
  s.rot = quat.fromAxisAngle([0.2, 0.9, -0.3], 0.8);
  return s;
}

const absoluteVelocity = (s: ShipState, t: number): Vec3 => v3.add(anchorState(fixtureSystem(), s.anchor, t).vel, s.vel);

describe('absolutePosition and reanchor', () => {
  it('absolute position is the anchor position plus the offset', () => {
    const sys = fixtureSystem();
    const s = shipAtStation();
    const station = anchorState(sys, FIXTURE_STATION, T).pos;
    expect(absolutePosition(s, sys, T)).toEqual(v3.add(station, s.pos));
    // The station is on its 7000 km orbit around the planet.
    const planet = anchorState(sys, FIXTURE_PLANET, T).pos;
    expect(v3.dist(station, planet) / FIXTURE_STATION_ORBIT).toBeCloseTo(1, 9);
  });

  it('reanchor preserves absolute position and velocity', () => {
    const sys = fixtureSystem();
    const s = shipAtStation();
    const pos = absolutePosition(s, sys, T);
    const vel = absoluteVelocity(s, T);
    for (const anchor of [FIXTURE_PLANET, FIXTURE_STAR, FIXTURE_BEACON, FIXTURE_STATION]) {
      reanchor(s, sys, anchor, T);
      expect(s.anchor).toBe(anchor);
      // Positions are of the order of 1 AU, where a double resolves about 3e-5 m.
      expect(v3.dist(absolutePosition(s, sys, T), pos)).toBeLessThan(1e-3);
      expect(v3.dist(absoluteVelocity(s, T), vel)).toBeLessThan(1e-6);
    }
    // Back in the original frame the offset is recovered.
    expect(v3.dist(s.pos, [10_000, -300, 50])).toBeLessThan(1e-3);
    expect(v3.dist(s.vel, [10, 2, -3])).toBeLessThan(1e-6);
  });

  it('reanchor to the same anchor changes nothing', () => {
    const sys = fixtureSystem();
    const s = shipAtStation();
    reanchor(s, sys, FIXTURE_STATION, T);
    expect(s.pos).toEqual([10_000, -300, 50]);
    expect(s.vel).toEqual([10, 2, -3]);
  });

  it('relative to the planet the station frame moves at orbital speed', () => {
    const sys = fixtureSystem();
    const s = shipAtStation();
    s.vel = [0, 0, 0];
    reanchor(s, sys, FIXTURE_PLANET, T);
    expect(v3.len(s.vel)).toBeGreaterThan(7000);
    expect(v3.len(s.vel)).toBeLessThan(8000);
  });
});

describe('cruise transitions', () => {
  it('engageCruise followed by disengageCruise keeps the absolute position', () => {
    const sys = fixtureSystem();
    const s = shipAtStation();
    const pos = absolutePosition(s, sys, T);
    const nose = forwardOf(s.rot);
    s.chargeKind = ChargeKind.Cruise;
    s.charge = 1;

    engageCruise(s, sys, T);
    expect(s.mode).toBe(FlightMode.Cruise);
    // Cruise anchors to the body whose sphere of influence holds the ship.
    expect(s.anchor).toBe(FIXTURE_PLANET);
    expect(s.cruiseSpeed).toBe(CRUISE_MIN_SPEED);
    expect(v3.dist(s.vel, v3.scale(nose, CRUISE_MIN_SPEED))).toBeLessThan(1e-6);
    expect(s.chargeKind).toBe(ChargeKind.None);
    expect(s.charge).toBe(0);
    expect(v3.dist(absolutePosition(s, sys, T), pos)).toBeLessThan(1e-3);

    const out = disengageCruise(s, sys, T);
    expect(out).toEqual({ anchor: FIXTURE_STATION, emergency: false });
    expect(s.mode).toBe(FlightMode.Normal);
    expect(s.anchor).toBe(FIXTURE_STATION);
    expect(s.cruiseSpeed).toBe(0);
    expect(v3.dist(absolutePosition(s, sys, T), pos)).toBeLessThan(1e-3);
    // At rest relative to the anchor apart from 100 m/s along the nose.
    expect(v3.dist(s.vel, v3.scale(nose, CRUISE_EXIT_SPEED))).toBeLessThan(1e-9);
    expect(CRUISE_EXIT_SPEED).toBe(100);
  });

  it('disengageCruise prefers the requested site only inside its frame radius', () => {
    const sys = fixtureSystem();
    // Inside the station's frame: the requested site wins.
    const near = shipAtStation([100_000, 0, 0]);
    engageCruise(near, sys, T);
    expect(disengageCruise(near, sys, T, FIXTURE_STATION).anchor).toBe(FIXTURE_STATION);

    // Far outside every site frame: the request is ignored and the body anchor is used.
    const far = newShipState(wisp);
    far.anchor = FIXTURE_PLANET;
    far.pos = [0, 20 * EARTH_RADIUS, 0];
    const pos = absolutePosition(far, sys, T);
    engageCruise(far, sys, T);
    const out = disengageCruise(far, sys, T, FIXTURE_STATION);
    expect(out.anchor).toBe(FIXTURE_PLANET);
    expect(far.anchor).toBe(FIXTURE_PLANET);
    expect(v3.dist(absolutePosition(far, sys, T), pos)).toBeLessThan(1e-3);
    // An unknown site id is ignored as well.
    engageCruise(far, sys, T);
    expect(disengageCruise(far, sys, T, 4711).anchor).toBe(FIXTURE_PLANET);
  });

  it('disengageCruise reports an emergency drop above the safe speed', () => {
    const sys = fixtureSystem();
    const s = shipAtStation();
    engageCruise(s, sys, T);
    s.cruiseSpeed = CRUISE_SAFE_DROP_SPEED * 2;
    expect(disengageCruise(s, sys, T).emergency).toBe(true);
    engageCruise(s, sys, T);
    s.cruiseSpeed = CRUISE_SAFE_DROP_SPEED * 0.5;
    expect(disengageCruise(s, sys, T).emergency).toBe(false);
  });

  it('canEngageCruise reports mass lock near a station but not near a beacon', () => {
    const sys = fixtureSystem();
    expect(canEngageCruise(shipAtStation([MASS_LOCK_RADIUS + 100, 0, 0]), sys, T)).toEqual({ ok: true });
    expect(canEngageCruise(shipAtStation([MASS_LOCK_RADIUS - 100, 0, 0]), sys, T)).toEqual({ ok: false, reason: 'masslock' });
    expect(canEngageCruise(shipAtStation([0, 0, 0]), sys, T)).toEqual({ ok: false, reason: 'masslock' });

    const atBeacon = newShipState(wisp);
    atBeacon.anchor = FIXTURE_BEACON;
    atBeacon.pos = [50, 0, 0];
    expect(canEngageCruise(atBeacon, sys, T)).toEqual({ ok: true });
    expect(isMassLocked(atBeacon, sys, T)).toBe(false);
  });

  it('mass lock is found whatever anchor the ship is expressed in', () => {
    const sys = fixtureSystem();
    const locked = shipAtStation([1000, 500, -200]);
    reanchor(locked, sys, FIXTURE_PLANET, T);
    expect(isMassLocked(locked, sys, T)).toBe(true);
    expect(canEngageCruise(locked, sys, T)).toEqual({ ok: false, reason: 'masslock' });
    const free = shipAtStation([30_000, 0, 0]);
    reanchor(free, sys, FIXTURE_STAR, T);
    expect(isMassLocked(free, sys, T)).toBe(false);
    expect(canEngageCruise(free, sys, T)).toEqual({ ok: true });
  });

  it('canEngageCruise reports mode, charging and fuel blocks', () => {
    const sys = fixtureSystem();
    const cruising = shipAtStation();
    engageCruise(cruising, sys, T);
    expect(canEngageCruise(cruising, sys, T)).toEqual({ ok: false, reason: 'mode' });
    const docked = shipAtStation();
    docked.mode = FlightMode.Docked;
    expect(canEngageCruise(docked, sys, T)).toEqual({ ok: false, reason: 'mode' });

    const charging = shipAtStation();
    charging.chargeKind = ChargeKind.Fold;
    expect(canEngageCruise(charging, sys, T)).toEqual({ ok: false, reason: 'charging' });
    charging.chargeKind = ChargeKind.Cruise;
    expect(canEngageCruise(charging, sys, T)).toEqual({ ok: false, reason: 'charging' });

    const dry = shipAtStation();
    dry.fuel = 0;
    expect(canEngageCruise(dry, sys, T)).toEqual({ ok: false, reason: 'fuel' });
  });
});

describe('placement', () => {
  it('placeAtSite puts the ship at rest at the requested distance, facing the site', () => {
    const sys = fixtureSystem();
    for (const distance of [800, 5000, 60_000]) {
      const s = shipAtStation();
      s.anchor = FIXTURE_PLANET;
      s.mode = FlightMode.Docked;
      s.angVel = [0.3, 0.1, -0.2];
      s.aim = [0.2, -0.1];
      s.chargeKind = ChargeKind.Fold;
      s.charge = 0.4;
      placeAtSite(s, sys, FIXTURE_STATION, T, new Rng(distance), distance);
      expect(s.mode).toBe(FlightMode.Normal);
      expect(s.anchor).toBe(FIXTURE_STATION);
      expect(v3.len(s.pos)).toBeCloseTo(distance, 6);
      expect(s.vel).toEqual([0, 0, 0]);
      expect(s.angVel).toEqual([0, 0, 0]);
      expect(s.aim).toEqual([0, 0]);
      expect(s.chargeKind).toBe(ChargeKind.None);
      expect(s.charge).toBe(0);
      // The nose points from the ship to the site at the anchor origin.
      const toSite = v3.normalize(v3.neg(s.pos));
      expect(v3.dot(forwardOf(s.rot), toSite)).toBeGreaterThan(1 - 1e-9);
    }
  });

  it('placeAtSite is deterministic in its rng and spreads ships around the site', () => {
    const sys = fixtureSystem();
    const a = newShipState(wisp);
    const b = newShipState(wisp);
    placeAtSite(a, sys, FIXTURE_STATION, T, new Rng('dock'), 2000);
    placeAtSite(b, sys, FIXTURE_STATION, T, new Rng('dock'), 2000);
    expect(a).toEqual(b);
    const rng = new Rng('many');
    const c = newShipState(wisp);
    const d = newShipState(wisp);
    placeAtSite(c, sys, FIXTURE_STATION, T, rng, 2000);
    placeAtSite(d, sys, FIXTURE_STATION, T, rng, 2000);
    expect(v3.dist(c.pos, d.pos)).toBeGreaterThan(1);
    expect(() => placeAtSite(a, sys, 4711, T, rng, 2000)).toThrow();
  });

  it('placeAtFoldArrival honours the minimum distance and faces away from the primary', () => {
    const sys = fixtureSystem();
    const fromDir: Vec3 = [0.6, 0.8, 0];
    const s = shipAtStation();
    s.throttle = 1;
    s.chargeKind = ChargeKind.Fold;
    s.charge = 1;
    placeAtFoldArrival(s, sys, T, fromDir, new Rng(1));
    expect(s.mode).toBe(FlightMode.Cruise);
    expect(s.throttle).toBe(0);
    expect(s.cruiseSpeed).toBe(CRUISE_MIN_SPEED);
    expect(s.chargeKind).toBe(ChargeKind.None);

    const abs = absolutePosition(s, sys, T);
    const distance = v3.len(abs);
    expect(distance).toBeGreaterThanOrEqual(FOLD_ARRIVAL_MIN * (1 - 1e-12));
    expect(distance / (FOLD_ARRIVAL_RADII * SOLAR_RADIUS)).toBeCloseTo(1, 9);
    expect(distance / foldArrivalDistance(sys)).toBeCloseTo(1, 9);
    // On the side the ship came from, nose pointing away from the primary.
    const outward = v3.normalize(abs);
    expect(v3.dot(outward, fromDir)).toBeGreaterThan(1 - 1e-9);
    expect(v3.dot(forwardOf(s.rot), outward)).toBeGreaterThan(1 - 1e-9);
    expect(v3.dist(s.vel, v3.scale(forwardOf(s.rot), CRUISE_MIN_SPEED))).toBeLessThan(1e-6);
  });

  it('placeAtFoldArrival picks a random side when no direction is given', () => {
    const sys = fixtureSystem();
    const sides: Vec3[] = [];
    for (const seed of [1, 2, 3]) {
      for (const dir of [null, [0, 0, 0] as Vec3, [NaN, 0, 1] as Vec3]) {
        const s = newShipState(wisp);
        placeAtFoldArrival(s, sys, T, dir, new Rng(seed));
        const abs = absolutePosition(s, sys, T);
        expect(v3.len(abs) / foldArrivalDistance(sys)).toBeCloseTo(1, 9);
        expect(v3.dot(forwardOf(s.rot), v3.normalize(abs))).toBeGreaterThan(1 - 1e-9);
        sides.push(v3.normalize(abs));
      }
    }
    // Same seed, same side; different seeds, different sides.
    expect(v3.dist(sides[0]!, sides[1]!)).toBeLessThan(1e-9);
    expect(v3.dist(sides[0]!, sides[3]!)).toBeGreaterThan(1e-3);
    expect(v3.dist(sides[3]!, sides[6]!)).toBeGreaterThan(1e-3);
  });

  it('placeAtFoldArrival keeps a survivable distance from a black hole', () => {
    const sys = blackHoleSystem();
    const s = newShipState(wisp);
    placeAtFoldArrival(s, sys, T, [0, 1, 0], new Rng(5));
    const abs = absolutePosition(s, sys, T);
    expect(v3.len(abs)).toBeGreaterThanOrEqual(FOLD_ARRIVAL_MIN);
    // 14 radii of a black hole would be deep inside the danger zone.
    expect(v3.len(abs)).toBeGreaterThan(1000 * FOLD_ARRIVAL_RADII * FIXTURE_BH_RS);
    const env = buildStepEnv(sys, s.anchor, T);
    const hz = hazardsAt(env, s, wisp);
    expect(hz.lethal).toBe(false);
    expect(hz.insideBody).toBe(-1);
    expect(hz.tidal).toBeLessThan(TIDAL_DAMAGE_THRESHOLD * 1e-3);
    expect(v3.len(gravityAt(env, s.pos))).toBeLessThanOrEqual(FOLD_ARRIVAL_MAX_GRAVITY * (1 + 1e-9));
    expect(v3.dot(forwardOf(s.rot), v3.normalize(abs))).toBeGreaterThan(1 - 1e-9);
  });
});

describe('foldFuelCost', () => {
  it('is Infinity beyond range and increasing in distance', () => {
    const range = wisp.jumpRange;
    expect(foldFuelCost(range * 1.0001, wisp)).toBe(Infinity);
    expect(foldFuelCost(1e6, wisp)).toBe(Infinity);
    expect(foldFuelCost(NaN, wisp)).toBe(Infinity);
    expect(foldFuelCost(1, { ...wisp, jumpRange: 0 })).toBe(Infinity);

    expect(foldFuelCost(0, wisp)).toBe(FOLD_FUEL_BASE);
    expect(foldFuelCost(range, wisp)).toBeCloseTo(FOLD_FUEL_BASE + FOLD_FUEL_PER_LY * range, 12);
    expect(foldFuelCost(range / 2, wisp)).toBeCloseTo(FOLD_FUEL_BASE + (FOLD_FUEL_PER_LY * range) / 4, 12);
    let last = foldFuelCost(0, wisp);
    for (let d = 0.25; d <= range; d += 0.25) {
      const cost = foldFuelCost(d, wisp);
      expect(Number.isFinite(cost)).toBe(true);
      expect(cost).toBeGreaterThan(last);
      last = cost;
    }
    // A full-range jump fits in the starter hull's tank.
    expect(foldFuelCost(range, wisp)).toBeLessThan(wisp.fuelCap);
  });
});
