import { describe, expect, it } from 'vitest';
import { computeShipStats, HULLS, starterLoadout } from '../catalog.ts';
import {
  BASE_PAD_RADIUS, BODY_EXCLUSION_FACTOR, BOOST_ENERGY, CRUISE_CEILING_MARGIN, CRUISE_EXIT_SPEED, CRUISE_GROUND_MIN_SPEED,
  CRUISE_MIN_SPEED, CRUISE_PROXIMITY_K, DT, G, GROUND_FRICTION, GROUND_RESTITUTION, LAND_MAX_SIDE, LAND_MAX_SINK,
  LAND_MAX_SLOPE_DEG, LAND_MAX_TILT_DEG, LIFTOFF_SPEED, LIFTOFF_THRUST, MASS_LOCK_RADIUS, PROTOCOL_VERSION, SOLAR_MASS,
} from '../constants.ts';
import { forwardOf, quat, upOf, v3, type Vec3 } from '../math.ts';
import { Rng } from '../prng.ts';
import { EntityFlag } from '../protocol.ts';
import { decodeSnapshot, encodeSnapshot } from '../snapshot.ts';
import { anchorState, bodyRotation, bodySpinRate, findSite, groundSiteRotation, pickNormalAnchor, surfaceAnchor } from '../universe/orbits.ts';
import { bodySurface, bodyTerrain, cruiseCeiling, groundAltitude, nearestGroundSite, systemSurfaces } from '../universe/surface.ts';
import { terrainHeight, terrainMax, terrainNormal, terrainParams } from '../universe/terrain.ts';
import {
  landingSystem, LANDING_BASE, LANDING_BASE_DIR, LANDING_GIANT, LANDING_MOON, LANDING_PLANET, LANDING_PLANET_DAY, LANDING_PLANET_MASS,
  LANDING_PLANET_RADIUS, LANDING_STAR, LANDING_STATION,
} from './fixtures.ts';
import { absolutePosition, absoluteVelocity, reanchor } from './frames.ts';
import {
  accelerationAt, buildStepEnv, cruiseSpeedFloor, cruiseSpeedLimit, gravityAt, hazardsAt, newShipState, simulateShip, stepShip,
} from './ship.ts';
import { shipSignature, SIG_LANDED } from './signature.ts';
import { bodyBelowCeiling, canEngageCruise, disengageCruise, engageCruise, isMassLocked, placeAtSite } from './transitions.ts';
import { Button, ChargeKind, FlightMode, type ShipInput, type ShipState, type ShipStats } from './types.ts';

const DEG = Math.PI / 180;
const wisp = computeShipStats(starterLoadout('wisp'));
const drover = computeShipStats(starterLoadout('drover'));
const sys = landingSystem();
const SURFACE = surfaceAnchor(LANDING_PLANET);
const surface = bodySurface(sys, LANDING_PLANET)!;
const base = findSite(sys, LANDING_BASE)!;
const PAD: Vec3 = v3.clone(base.ground!.pos);
const PAD_UP: Vec3 = v3.normalize(PAD);
const T0 = 50_000;

const input = (over: Partial<ShipInput> = {}): ShipInput => ({ seq: 0, thrust: [0, 0, 0], aim: [0, 0], roll: 0, throttle: 0, buttons: 0, ...over });
const NONE = input();

const clone = (s: ShipState): ShipState => ({
  ...s, pos: v3.clone(s.pos), vel: v3.clone(s.vel), rot: quat.clone(s.rot), angVel: v3.clone(s.angVel), aim: [s.aim[0], s.aim[1]],
});

/** Height of the ship's belly above the ground beneath it, metres. */
const clearance = (s: ShipState, stats: ShipStats = wisp): number => groundAltitude(surface, s.pos) - stats.belly;

/** A ship in the planet's surface frame, level (up along the local vertical), at rest over the ground. */
function shipAbove(dir: Readonly<Vec3>, height: number, stats: ShipStats = wisp): ShipState {
  const s = newShipState(stats);
  const up = v3.normalize(dir);
  const ground = LANDING_PLANET_RADIUS + terrainHeight(surface.terrain, up[0], up[1], up[2]);
  s.anchor = SURFACE;
  s.pos = v3.scale(up, ground + stats.belly + height);
  // Nose along the ground, up along the vertical.
  s.rot = quat.lookRotation(v3.cross(up, Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]), up);
  return s;
}

/** Steps a ship for `seconds`; returns the largest impact reported and whether cruise dropped. */
function run(s: ShipState, inp: ShipInput, seconds: number, stats: ShipStats = wisp, t0 = T0): { impact: number; drops: number; t: number } {
  const ticks = Math.round(seconds / DT);
  let impact = 0;
  let drops = 0;
  for (let i = 0; i < ticks; i++) {
    const env = simulateShip(s, inp, stats, sys, t0 + i * DT, DT);
    if ((env.impact ?? 0) > impact) impact = env.impact!;
    if (env.cruiseDrop) drops++;
  }
  return { impact, drops, t: t0 + ticks * DT };
}

/** Flies a level ship down onto the ground with flight assist until it has landed (or `seconds` have passed). */
function descend(s: ShipState, sink: number, seconds = 60, stats: ShipStats = wisp): { impact: number; t: number } {
  // Flight assist turns the up/down key into a vertical speed of 0.7 of the hull's rated speed.
  const down = input({ thrust: [0, -sink / (0.7 * stats.maxSpeed), 0] });
  let impact = 0;
  let t = T0;
  for (let i = 0; i < seconds / DT && s.mode === FlightMode.Normal; i++) {
    const env = simulateShip(s, down, stats, sys, t, DT);
    impact = Math.max(impact, env.impact ?? 0);
    t += DT;
  }
  return { impact, t };
}

/** A direction on the planet where the ground under a ship is steeper than `minDeg` (and not absurdly so). */
function steepSpot(minDeg: number, maxDeg: number): Vec3 {
  const rng = new Rng(77);
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < 20_000; i++) {
    const d = v3.normalize([rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)]);
    const slope = terrainNormal(surface.terrain, d[0], d[1], d[2], Math.max(2 * wisp.radius, 10), n);
    if (slope > Math.tan(minDeg * DEG) && slope < Math.tan(maxDeg * DEG)) return d;
  }
  throw new Error('no steep ground found');
}

describe('the environment of a surface frame', () => {
  it('has the body at its origin, the other bodies in body-fixed axes, the spin and the ground', () => {
    const env = buildStepEnv(sys, SURFACE, T0);
    expect(env.anchor).toBe(SURFACE);
    const planet = env.sources[LANDING_PLANET]!;
    expect(planet.pos).toEqual([0, 0, 0]);
    expect(planet.isAnchor).toBe(true);
    expect(env.sources.filter((s) => s.isAnchor).length).toBe(1);
    // The star is where it is in system axes, turned into the axes of the body.
    const body = sys.bodies[LANDING_PLANET]!;
    const toStar = v3.sub(anchorState(sys, LANDING_STAR, T0).pos, anchorState(sys, LANDING_PLANET, T0).pos);
    expect(v3.dist(env.sources[LANDING_STAR]!.pos, quat.unrotate(bodyRotation(body, T0), toStar)) / v3.len(toStar)).toBeLessThan(1e-12);
    // A quarter of a day later it stands a quarter turn further around the axis.
    const later = buildStepEnv(sys, SURFACE, T0 + LANDING_PLANET_DAY / 4).sources[LANDING_STAR]!.pos;
    const now = env.sources[LANDING_STAR]!.pos;
    expect(Math.abs(later[1] - now[1]) / v3.len(now)).toBeLessThan(1e-3);
    expect(Math.abs(now[0] * later[0] + now[2] * later[2]) / (now[0] * now[0] + now[2] * now[2])).toBeLessThan(2e-3);

    expect(env.omega).toEqual([0, bodySpinRate(body), 0]);
    expect(env.ground).toEqual({ body: LANDING_PLANET, radius: LANDING_PLANET_RADIUS, top: surface.top, exit: surface.exit, terrain: surface.terrain });
    expect(env.impact).toBe(0);
    // Frames that do not turn carry neither.
    const inertial = buildStepEnv(sys, LANDING_PLANET, T0);
    expect(inertial.omega).toBeUndefined();
    expect(inertial.ground).toBeUndefined();
    // Every environment marks the bodies that can be landed on, and only those.
    for (const e of [env, inertial, buildStepEnv(sys, LANDING_STATION, T0)]) {
      expect(e.sources.map((s) => s.surface !== undefined)).toEqual([false, true, true, false]);
      expect(e.sources[LANDING_PLANET]!.surface!.enter).toBe(surface.enter);
      expect(e.sources[LANDING_PLANET]!.surface!.ceiling).toBe(surface.ceiling);
    }
    expect(() => buildStepEnv(sys, surfaceAnchor(LANDING_GIANT), T0)).toThrow();
  });

  it('adds the pads of the ground bases to the terrain of their body, once per system', () => {
    expect(systemSurfaces(sys)).toBe(systemSurfaces(sys));
    expect(bodyTerrain(sys, LANDING_PLANET)).toBe(surface.terrain);
    expect(bodyTerrain(sys, LANDING_GIANT)).toBeNull();
    expect(surface.sites).toEqual([base]);
    expect(surface.top).toBe(LANDING_PLANET_RADIUS + terrainMax(surface.terrain));
    expect(surface.ceiling).toBe(surface.top + CRUISE_CEILING_MARGIN);
    expect(cruiseCeiling(sys, LANDING_PLANET)).toBe(surface.ceiling);
    expect(cruiseCeiling(sys, LANDING_STAR)).toBeNull();
    // The pad is flat at the height of the site, out to its radius.
    const natural = terrainParams(sys.bodies[LANDING_PLANET]!);
    const padHeight = v3.len(PAD) - LANDING_PLANET_RADIUS;
    expect(Math.abs(terrainHeight(surface.terrain, PAD_UP[0], PAD_UP[1], PAD_UP[2]) - padHeight)).toBeLessThan(1e-6);
    const side = v3.normalize(v3.cross(PAD_UP, [0, 1, 0]));
    const off = v3.normalize(v3.addScaled(PAD_UP, side, (0.9 * BASE_PAD_RADIUS) / LANDING_PLANET_RADIUS));
    expect(Math.abs(terrainHeight(surface.terrain, off[0], off[1], off[2]) - padHeight)).toBeLessThan(1e-6);
    expect(Math.abs(terrainHeight(natural, off[0], off[1], off[2]) - padHeight)).toBeGreaterThan(1e-3);
    expect(groundAltitude(surface, v3.scale(off, v3.len(PAD) + 25))).toBeCloseTo(25, 6);
    expect(nearestGroundSite(sys, LANDING_PLANET, v3.addScaled(PAD, PAD_UP, 300))).toEqual({ site: base, dist: 300 });
    expect(nearestGroundSite(sys, LANDING_MOON, [4e5, 0, 0])).toBeNull();
    // A gate added later (the sites change) rebuilds the cache.
    const other = landingSystem();
    const before = systemSurfaces(other);
    other.sites.push({ ...findSite(other, LANDING_STATION)!, id: LANDING_BASE + 1, name: 'Late' });
    expect(systemSurfaces(other)).not.toBe(before);
  });
});

describe('flight in a surface frame', () => {
  it('holds its height and its place over the ground with flight assist and no input', () => {
    // 1,000 m/s of ground speed at this latitude; the ship neither falls nor is flung off.
    for (const dir of [PAD_UP, [1, 0, 0], [0, 1, 0], [-0.5, 0.2, 0.84]] as Vec3[]) {
      const s = shipAbove(dir, 500);
      const start = v3.clone(s.pos);
      const { impact } = run(s, NONE, 60);
      expect(s.mode).toBe(FlightMode.Normal);
      expect(s.anchor).toBe(SURFACE);
      expect(v3.dist(s.pos, start)).toBeLessThan(1e-6);
      expect(v3.len(s.vel)).toBeLessThan(1e-6);
      expect(impact).toBe(0);
    }
  });

  it('falls with the pull of the body less what its spin takes off, with flight assist off', () => {
    const off = input({ buttons: Button.FaOff });
    const omega = (2 * Math.PI) / LANDING_PLANET_DAY;
    for (const dir of [[1, 0, 0], [0, 1, 0], PAD_UP] as Vec3[]) {
      const s = shipAbove(dir, 3000);
      const start = v3.clone(s.pos);
      const r = v3.len(start);
      // Worked out here from first principles: gravity toward the centre, the centrifugal term away from the axis (+Y).
      const pull = (G * LANDING_PLANET_MASS) / (r * r);
      const expected: Vec3 = [
        -pull * (start[0] / r) + omega * omega * start[0],
        -pull * (start[1] / r),
        -pull * (start[2] / r) + omega * omega * start[2],
      ];
      const env = buildStepEnv(sys, SURFACE, T0);
      // The star's tide is all that is left out above: under a millionth of a g.
      expect(v3.dist(accelerationAt(env, start, [0, 0, 0]), expected)).toBeLessThan(1e-5);
      expect(v3.dist(gravityAt(env, start), [-pull * (start[0] / r), -pull * (start[1] / r), -pull * (start[2] / r)])).toBeLessThan(1e-5);
      const seconds = 10;
      run(s, off, seconds);
      const moved = v3.sub(s.pos, start);
      // Half a t squared, to within what one tick and the Coriolis drift of a ten second fall make.
      expect(v3.dist(moved, v3.scale(expected, 0.5 * seconds * seconds)) / v3.len(moved)).toBeLessThan(0.01);
      expect(v3.len(moved)).toBeGreaterThan(100);
    }
    // On the equator the spin takes off about an eighth of the pull.
    const g = v3.len(gravityAt(buildStepEnv(sys, SURFACE, T0), [LANDING_PLANET_RADIUS, 0, 0]));
    const felt = v3.len(accelerationAt(buildStepEnv(sys, SURFACE, T0), [LANDING_PLANET_RADIUS, 0, 0], [0, 0, 0]));
    expect(g).toBeCloseTo(3.46, 1);
    expect((g - felt) / g).toBeGreaterThan(0.1);
    expect((g - felt) / g).toBeLessThan(0.15);
  });

  it('flies the same path as in the frame that does not turn: orbits and falls are physically right', () => {
    const off = input({ buttons: Button.FaOff });
    for (const [dir, vel] of [
      [[1, 0, 0], [40, 300, -500]],
      [[0.6, 0.48, 0.64], [-700, 100, 250]],
      [[0, -1, 0], [0, 20, 900]],
    ] as [Vec3, Vec3][]) {
      const a = shipAbove(dir, 80_000);
      a.vel = v3.clone(vel);
      const b = clone(a);
      reanchor(b, sys, LANDING_PLANET, T0);
      // The twin is stepped by hand in the body frame, which `simulateShip` would not leave it in this low.
      const seconds = 120;
      for (let i = 0; i < seconds / DT; i++) {
        const t = T0 + i * DT;
        stepShip(a, off, wisp, buildStepEnv(sys, SURFACE, t), DT);
        stepShip(b, off, wisp, buildStepEnv(sys, LANDING_PLANET, t), DT);
      }
      const t1 = T0 + seconds;
      // With either fictitious force missing or reversed the two would be kilometres apart by now.
      expect(v3.dist(absolutePosition(a, sys, t1), absolutePosition(b, sys, t1))).toBeLessThan(2);
      expect(v3.dist(absoluteVelocity(a, sys, t1), absoluteVelocity(b, sys, t1))).toBeLessThan(0.05);
      expect(v3.dist(absolutePosition(a, sys, t1), absolutePosition(shipAbove(dir, 80_000), sys, t1))).toBeGreaterThan(10_000);
    }
  });

  it('stops over the ground when the keys are released, whatever the ground itself is doing', () => {
    const s = shipAbove([1, 0, 0], 2000);
    run(s, input({ thrust: [0.5, 0, 1] }), 8);
    expect(v3.len(s.vel)).toBeGreaterThan(100);
    run(s, NONE, 25);
    expect(v3.len(s.vel)).toBeLessThan(0.01);
    // Seen from outside it then moves with the ground, at about a kilometre a second.
    const t = T0 + 33;
    expect(v3.len(v3.sub(absoluteVelocity(s, sys, t), anchorState(sys, LANDING_PLANET, t).vel))).toBeGreaterThan(900);
  });
});

describe('crossing between the body frame and the surface frame', () => {
  const enter = surface.enter;
  const exit = surface.exit;

  it('moves a ship into the surface frame as it comes down and back out above 1.3 times the height', () => {
    const off = input({ buttons: Button.FaOff });
    // Falling in from just above the boundary, in the frame of the body.
    const s = newShipState(wisp);
    s.anchor = LANDING_PLANET;
    s.pos = [enter + 300, 0, 0];
    s.vel = [-200, 30, 900];
    const twin = clone(s);
    let crossedAt = -1;
    for (let i = 0; i < 20 / DT; i++) {
      const t = T0 + i * DT;
      simulateShip(s, off, wisp, sys, t, DT);
      // The twin never changes frame.
      stepShip(twin, off, wisp, buildStepEnv(sys, LANDING_PLANET, t), DT);
      if (crossedAt < 0 && s.anchor === SURFACE) {
        crossedAt = i;
        // The trajectory did not notice.
        expect(v3.dist(absolutePosition(s, sys, t + DT), absolutePosition(twin, sys, t + DT))).toBeLessThan(1e-3);
        expect(v3.dist(absoluteVelocity(s, sys, t + DT), absoluteVelocity(twin, sys, t + DT))).toBeLessThan(1e-6);
        expect(v3.len(s.pos)).toBeLessThan(enter);
      }
    }
    expect(crossedAt).toBeGreaterThan(10);
    expect(s.anchor).toBe(SURFACE);
    const t1 = T0 + 20;
    expect(v3.dist(absolutePosition(s, sys, t1), absolutePosition(twin, sys, t1))).toBeLessThan(0.5);

    // Climbing: it stays in the surface frame between the two heights and leaves it above the upper one.
    const up = shipAbove([1, 0, 0], 0);
    up.pos = [enter + 1000, 0, 0];
    up.vel = [1500, 0, 0];
    run(up, off, 5);
    expect(v3.len(up.pos)).toBeGreaterThan(enter + 6000);
    expect(up.anchor).toBe(SURFACE);
    let highest = 0;
    for (let i = 0; i < 120 / DT && up.anchor === SURFACE; i++) {
      highest = v3.len(up.pos);
      simulateShip(up, off, wisp, sys, T0 + 5 + i * DT, DT);
    }
    expect(up.anchor).toBe(LANDING_PLANET);
    // The last position it had in the surface frame was still below the upper height, the next one above it.
    expect(highest).toBeLessThanOrEqual(exit);
    expect(v3.len(up.pos)).toBeGreaterThan(exit);
    expect(exit - enter).toBeCloseTo(0.3 * 240_000, 6);
    // And it does not flip back while it is above the lower one: braked to a stop there, it stays.
    run(up, NONE, 150, wisp, T0 + 200);
    expect(v3.len(up.vel)).toBeLessThan(0.01);
    expect(v3.len(up.pos)).toBeGreaterThan(enter);
    expect(up.anchor).toBe(LANDING_PLANET);
  });

  it('takes a ship out of any other frame once it is low enough', () => {
    for (const anchor of [LANDING_STAR, LANDING_MOON, LANDING_STATION]) {
      const s = shipAbove([0, 0, 1], 100_000);
      reanchor(s, sys, anchor, T0);
      expect(s.anchor).toBe(anchor);
      const before = absolutePosition(s, sys, T0);
      simulateShip(s, NONE, wisp, sys, T0, DT);
      expect(s.anchor).toBe(SURFACE);
      // Flight assist was braking against the old frame for one tick; the ship is where it was to within that.
      expect(v3.dist(absolutePosition(s, sys, T0 + DT), v3.add(before, v3.scale(anchorState(sys, LANDING_PLANET, T0).vel, DT)))).toBeLessThan(100);
    }
  });

  it('leaves a freshly placed ship in the frame it was given', () => {
    const centre = anchorState(sys, LANDING_PLANET, T0).pos;
    for (const height of [500, 100_000, 239_000, 241_000, 300_000, 320_000, 2_000_000]) {
      const abs = v3.add(centre, v3.scale(v3.normalize([2, -1, 2]), LANDING_PLANET_RADIUS + height));
      const s = newShipState(wisp);
      s.anchor = LANDING_STAR;
      s.pos = abs;
      const anchor = pickNormalAnchor(sys, abs, T0);
      reanchor(s, sys, anchor, T0);
      s.vel = [0, 0, 0];
      expect(anchor).toBe(height < 240_000 ? SURFACE : LANDING_PLANET);
      run(s, NONE, 1);
      expect(s.anchor, `at ${height} m`).toBe(anchor);
    }
  });
});

describe('landing', () => {
  it('lands from a gentle descent: on the ground, upright, heading kept, at rest', () => {
    const s = shipAbove(PAD_UP, 40);
    // Heading somewhere, and leaning a little: nose up and one wing low.
    s.rot = quat.mul(quat.mul(quat.mul(s.rot, quat.fromAxisAngle([0, 1, 0], 0.7)), quat.fromAxisAngle([1, 0, 0], 0.2)), quat.fromAxisAngle([0, 0, 1], 0.15));
    expect(v3.dist(upOf(s.rot), PAD_UP)).toBeGreaterThan(0.2);
    const heading = forwardOf(s.rot);
    const { impact } = descend(s, 3);
    expect(s.mode).toBe(FlightMode.Landed);
    expect(impact).toBe(0);
    expect(s.vel).toEqual([0, 0, 0]);
    expect(s.angVel).toEqual([0, 0, 0]);
    expect(Math.abs(clearance(s))).toBeLessThan(1e-6);
    // The pad is level, so its normal is the local vertical.
    expect(v3.dist(upOf(s.rot), v3.normalize(s.pos))).toBeLessThan(1e-9);
    const flat = v3.normalize(v3.sub(heading, v3.scale(PAD_UP, v3.dot(heading, PAD_UP))));
    expect(v3.dist(forwardOf(s.rot), flat)).toBeLessThan(1e-3);
    // It leaned, so the descent drifted a few metres off the centre of the pad.
    expect(v3.dist(s.pos, v3.addScaled(PAD, PAD_UP, wisp.belly))).toBeLessThan(15);
  });

  it('stands the ship on its belly: 0.3 of the hull radius above the ground for now', () => {
    for (const id of Object.keys(HULLS)) {
      expect(HULLS[id]!.belly).toBeCloseTo(0.3 * HULLS[id]!.radius, 12);
      expect(computeShipStats(starterLoadout(id)).belly).toBe(HULLS[id]!.belly);
    }
    const s = shipAbove(PAD_UP, 20, drover);
    descend(s, 2, 60, drover);
    expect(s.mode).toBe(FlightMode.Landed);
    expect(v3.len(s.pos) - v3.len(PAD)).toBeCloseTo(drover.belly, 6);
  });

  it('stays put for an hour while the body turns under it, and its systems recover', () => {
    const s = shipAbove(PAD_UP, 10);
    const { t } = descend(s, 3);
    expect(s.mode).toBe(FlightMode.Landed);
    s.energy = 1;
    s.shield = 0;
    s.shieldDelay = 0;
    const stood = clone(s);
    const where = absolutePosition(s, sys, t);
    const end = run(s, NONE, 3600, wisp, t).t;
    expect(s.mode).toBe(FlightMode.Landed);
    expect(s.anchor).toBe(SURFACE);
    // Not a bit of drift over the ground.
    expect(s.pos).toEqual(stood.pos);
    expect(s.rot).toEqual(stood.rot);
    expect(s.vel).toEqual([0, 0, 0]);
    // The ground carried it a quarter of the way around the axis meanwhile.
    const pad = v3.dist(absolutePosition(s, sys, end), anchorState(sys, LANDING_BASE, end).pos);
    expect(pad).toBeCloseTo(v3.dist(where, anchorState(sys, LANDING_BASE, t).pos), 2);
    const rel0 = v3.sub(where, anchorState(sys, LANDING_PLANET, t).pos);
    const rel1 = v3.sub(absolutePosition(s, sys, end), anchorState(sys, LANDING_PLANET, end).pos);
    expect(v3.dist(rel0, rel1)).toBeGreaterThan(1e6);
    expect(s.energy).toBe(wisp.energyMax);
    expect(s.shield).toBe(wisp.shieldMax);
    // A landed ship is still in the world: its tick has the whole environment, for the star's heat
    // on its hull and for whatever the server asks about the place it stands on.
    const env = simulateShip(s, NONE, wisp, sys, end, DT);
    expect(env.anchor).toBe(SURFACE);
    expect(env.sources.length).toBe(sys.bodies.length);
    expect(env.ground).toBeDefined();
    expect(env.impact).toBe(0);
    const hz = hazardsAt(env, s, wisp);
    expect(hz.heatInflux).toBeGreaterThan(0.05);
    expect(hz.insideBody).toBe(-1);
    expect(hz.dominantBody).toBe(LANDING_PLANET);
  });

  it('has a low heat signature on the ground', () => {
    const s = shipAbove(PAD_UP, 5);
    const flying = shipSignature(s, wisp, 0, false);
    descend(s, 3);
    expect(s.mode).toBe(FlightMode.Landed);
    run(s, NONE, 1);
    expect(s.sig).toBeGreaterThan(0);
    expect(s.sig).toBeCloseTo(flying * SIG_LANDED, 9);
    expect(s.sig).toBe(shipSignature(s, wisp, 0, false));
    // Thrust that is not there does not show, and silent running still hides the rest.
    expect(shipSignature(s, wisp, 5, false)).toBe(s.sig);
    run(s, input({ buttons: Button.Silent }), 0.2);
    expect(s.sig).toBeLessThan(0.1 * flying * SIG_LANDED + 1e-9);
  });

  it('bounces off the ground in a hard descent and reports how hard', () => {
    const off = input({ buttons: Button.FaOff });
    const s = shipAbove(PAD_UP, 3);
    s.vel = v3.scale(PAD_UP, -40);
    let impact = 0;
    let hits = 0;
    for (let i = 0; i < 10 && hits === 0; i++) {
      const env = simulateShip(s, off, wisp, sys, T0 + i * DT, DT);
      if (env.impact! > 0) {
        hits++;
        impact = env.impact!;
      }
    }
    expect(hits).toBe(1);
    expect(s.mode).toBe(FlightMode.Normal);
    // 40 m/s into the ground, 6 of which a landing would have allowed.
    expect(impact).toBeGreaterThan(40 - LAND_MAX_SINK);
    expect(impact).toBeLessThan(40.5 - LAND_MAX_SINK);
    // It comes back up with a quarter of the speed and its belly on the ground.
    expect(v3.dot(s.vel, PAD_UP)).toBeCloseTo(GROUND_RESTITUTION * (40 + impact - (40 - LAND_MAX_SINK)), 6);
    expect(Math.abs(clearance(s))).toBeLessThan(1e-6);
    // The next tick is free flight again: nothing more to report.
    expect(simulateShip(s, off, wisp, sys, T0 + 1, DT).impact).toBe(0);
    expect(clearance(s)).toBeGreaterThan(0);
  });

  it('scrapes along the ground when it comes in too fast sideways', () => {
    const off = input({ buttons: Button.FaOff });
    const s = shipAbove(PAD_UP, 0.02);
    const along = forwardOf(s.rot);
    s.vel = v3.add(v3.scale(along, 50), v3.scale(PAD_UP, -2));
    const env = simulateShip(s, off, wisp, sys, T0, DT);
    expect(s.mode).toBe(FlightMode.Normal);
    expect(env.impact!).toBeCloseTo(50 - LAND_MAX_SIDE, 1);
    expect(v3.dot(s.vel, along)).toBeCloseTo(50 * (1 - GROUND_FRICTION), 1);
    expect(v3.dot(s.vel, PAD_UP)).toBeGreaterThan(0);
    // Within the limits on both counts it would have landed.
    const gentle = shipAbove(PAD_UP, 0.02);
    gentle.vel = v3.add(v3.scale(along, LAND_MAX_SIDE - 0.5), v3.scale(PAD_UP, -(LAND_MAX_SINK - 0.5)));
    expect(simulateShip(gentle, off, wisp, sys, T0, DT).impact).toBe(0);
    expect(gentle.mode).toBe(FlightMode.Landed);
    // And just beyond either one it does not.
    for (const [sideways, sink] of [[LAND_MAX_SIDE + 0.5, 1], [1, LAND_MAX_SINK + 0.5]] as const) {
      const hard = shipAbove(PAD_UP, 0.02);
      hard.vel = v3.add(v3.scale(along, sideways), v3.scale(PAD_UP, -sink));
      const e = simulateShip(hard, off, wisp, sys, T0, DT);
      expect(hard.mode).toBe(FlightMode.Normal);
      expect(e.impact!).toBeGreaterThan(0.4);
      expect(e.impact!).toBeLessThan(0.7);
    }
  });

  it('does not land on ground that is too steep', () => {
    const dir = steepSpot(LAND_MAX_SLOPE_DEG + 4, 40);
    const s = shipAbove(dir, 15);
    // Tilted to stand square on the slope, so that only the slope is in the way.
    const n: Vec3 = [0, 0, 0];
    terrainNormal(surface.terrain, dir[0], dir[1], dir[2], Math.max(2 * wisp.radius, 10), n);
    const fwd = forwardOf(s.rot);
    s.rot = quat.lookRotation(v3.sub(fwd, v3.scale(n, v3.dot(fwd, n))), n);
    const down = input({ thrust: [0, -3 / (0.7 * wisp.maxSpeed), 0] });
    let touched = 0;
    let worst = 0;
    for (let i = 0; i < 30 / DT; i++) {
      const before = clearance(s);
      const env = simulateShip(s, down, wisp, sys, T0 + i * DT, DT);
      expect(s.mode).toBe(FlightMode.Normal);
      if (clearance(s) < 1e-6 && before > 0) touched++;
      worst = Math.max(worst, env.impact!);
      // It never sinks into the ground either.
      expect(clearance(s)).toBeGreaterThan(-1e-6);
    }
    expect(touched).toBeGreaterThan(0);
    // A gentle touch does no harm, landed or not.
    expect(worst).toBe(0);

    // The same descent on a gentle slope does land, standing on the slope.
    const easy = steepSpot(8, LAND_MAX_SLOPE_DEG - 4);
    const e = shipAbove(easy, 15);
    descend(e, 3);
    expect(e.mode).toBe(FlightMode.Landed);
    terrainNormal(surface.terrain, easy[0], easy[1], easy[2], Math.max(2 * wisp.radius, 10), n);
    expect(v3.dist(upOf(e.rot), n)).toBeLessThan(1e-3);
    expect(Math.acos(v3.dot(upOf(e.rot), v3.normalize(e.pos))) / DEG).toBeGreaterThan(7);
  });

  it('does not land a ship that is not upright', () => {
    for (const [tilt, lands] of [[LAND_MAX_TILT_DEG + 8, false], [LAND_MAX_TILT_DEG - 8, true]] as const) {
      const s = shipAbove(PAD_UP, 0.05);
      s.rot = quat.mul(s.rot, quat.fromAxisAngle([0, 0, 1], tilt * DEG));
      s.vel = v3.scale(PAD_UP, -2);
      const env = simulateShip(s, input({ buttons: Button.FaOff }), wisp, sys, T0, DT);
      expect(env.impact).toBe(0);
      expect(s.mode).toBe(lands ? FlightMode.Landed : FlightMode.Normal);
      if (!lands) expect(v3.dot(s.vel, PAD_UP)).toBeGreaterThan(0);
    }
  });

  it('catches a ship that would otherwise pass through the ground between two ticks', () => {
    const s = shipAbove([0, 0, -1], 100);
    s.vel = v3.scale(v3.normalize(s.pos), -6000);
    const env = simulateShip(s, input({ buttons: Button.FaOff }), wisp, sys, T0, DT);
    expect(env.impact!).toBeGreaterThan(5900);
    expect(Math.abs(clearance(s))).toBeLessThan(1e-6);
    // The hazard check has no exclusion radius for a landable body: the terrain was the limit.
    expect(hazardsAt(env, s, wisp).insideBody).toBe(-1);
  });
});

describe('lift-off', () => {
  const landed = (): { s: ShipState; t: number } => {
    const s = shipAbove(PAD_UP, 5);
    const { t } = descend(s, 3);
    expect(s.mode).toBe(FlightMode.Landed);
    return { s, t };
  };

  it('lifts off on up thrust and climbs away', () => {
    const { s, t } = landed();
    const up = input({ thrust: [0, 1, 0] });
    simulateShip(s, up, wisp, sys, t, DT);
    expect(s.mode).toBe(FlightMode.Normal);
    expect(v3.dot(s.vel, PAD_UP)).toBeGreaterThan(LIFTOFF_SPEED);
    expect(clearance(s)).toBeGreaterThan(0.05);
    let last = clearance(s);
    for (let i = 1; i < 60; i++) {
      simulateShip(s, up, wisp, sys, t + i * DT, DT);
      expect(s.mode).toBe(FlightMode.Normal);
      expect(clearance(s)).toBeGreaterThan(last);
      last = clearance(s);
    }
    expect(last).toBeGreaterThan(20);
  });

  it('does not fall back onto the ground when the key is let go at once', () => {
    const { s, t } = landed();
    simulateShip(s, input({ thrust: [0, LIFTOFF_THRUST + 0.05, 0] }), wisp, sys, t, DT);
    expect(s.mode).toBe(FlightMode.Normal);
    for (let i = 1; i < 10 / DT; i++) {
      simulateShip(s, NONE, wisp, sys, t + i * DT, DT);
      expect(s.mode).toBe(FlightMode.Normal);
    }
    // Flight assist caught the hop: the ship hovers about a metre up.
    expect(clearance(s)).toBeGreaterThan(0.3);
    expect(clearance(s)).toBeLessThan(5);
    expect(v3.len(s.vel)).toBeLessThan(1e-3);
  });

  it('lifts off on boost, and spends the boost doing it', () => {
    const { s, t } = landed();
    const energy = s.energy;
    simulateShip(s, input({ buttons: Button.Boost }), wisp, sys, t, DT);
    expect(s.mode).toBe(FlightMode.Normal);
    expect(s.boost).toBeGreaterThan(0);
    expect(s.energy).toBeLessThan(energy - BOOST_ENERGY + 1);
    // Without the energy for it the button does nothing.
    const flat = landed();
    flat.s.energy = BOOST_ENERGY - 5;
    simulateShip(flat.s, input({ buttons: Button.Boost }), wisp, sys, flat.t, DT);
    expect(flat.s.mode).toBe(FlightMode.Landed);
  });

  it('is not moved by any other input', () => {
    const { s, t } = landed();
    const stood = clone(s);
    const rng = new Rng(3);
    for (let i = 0; i < 300; i++) {
      const inp = input({
        thrust: [rng.range(-1, 1), rng.range(-1, LIFTOFF_THRUST), rng.range(-1, 1)],
        aim: [rng.range(-0.1, 0.1), rng.range(-0.1, 0.1)],
        roll: rng.range(-1, 1),
        throttle: rng.range(-1, 1),
        buttons: (rng.chance(0.5) ? Button.Brake : 0) | (rng.chance(0.5) ? Button.FaOff : 0) | (rng.chance(0.3) ? Button.Fire1 : 0),
      });
      simulateShip(s, inp, wisp, sys, t + i * DT, DT);
    }
    expect(s.mode).toBe(FlightMode.Landed);
    expect(s.pos).toEqual(stood.pos);
    expect(s.rot).toEqual(stood.rot);
    expect(s.vel).toEqual([0, 0, 0]);
    expect(s.angVel).toEqual([0, 0, 0]);
    expect(s.aim).toEqual([0, 0]);
  });

  it('hops and comes down again without flight assist when the engines cannot hold the ship', () => {
    const { s, t } = landed();
    // A tap on the key with the assist off: a hop of LIFTOFF_SPEED against 3.4 m/s^2.
    simulateShip(s, input({ thrust: [0, 1, 0], buttons: Button.FaOff }), wisp, sys, t, DT);
    expect(s.mode).toBe(FlightMode.Normal);
    const end = run(s, input({ buttons: Button.FaOff }), 20, wisp, t + DT);
    expect(end.impact).toBe(0);
    expect(s.mode).toBe(FlightMode.Landed);
    expect(v3.dist(s.pos, v3.addScaled(PAD, PAD_UP, wisp.belly))).toBeLessThan(5);
  });
});

describe('prediction', () => {
  it('replays the same inputs from the same state to the same bits, through landing and lift-off', () => {
    const rng = new Rng(2024);
    const inputs: ShipInput[] = [];
    for (let i = 0; i < 1500; i++) {
      // Down onto the pad, a while on the ground, up again, around, and down hard.
      const phase = Math.floor(i / 300);
      const up = phase === 0 ? -0.02 : phase === 1 ? 0 : phase === 2 ? 0.6 : phase === 3 ? rng.range(-0.3, 0.3) : -0.4;
      inputs.push(input({
        seq: i,
        thrust: [phase === 3 ? rng.range(-1, 1) : 0, up, phase === 3 ? rng.range(-1, 1) : 0],
        aim: phase === 3 ? [rng.range(-0.02, 0.02), rng.range(-0.02, 0.02)] : [0, 0],
        roll: phase === 3 ? rng.range(-0.3, 0.3) : 0,
        buttons: phase === 4 && rng.chance(0.5) ? Button.FaOff : 0,
      }));
    }
    const start = shipAbove(PAD_UP, 4);
    const play = (): { s: ShipState; modes: Set<number>; impacts: number[] } => {
      const s = clone(start);
      const modes = new Set<number>();
      const impacts: number[] = [];
      inputs.forEach((inp, i) => {
        const env = simulateShip(s, inp, wisp, sys, T0 + i * DT, DT);
        modes.add(s.mode);
        if (env.impact! > 0) impacts.push(env.impact!);
      });
      return { s, modes, impacts };
    };
    const a = play();
    const b = play();
    expect(a.s).toEqual(b.s);
    expect(a.impacts).toEqual(b.impacts);
    expect(a.modes.has(FlightMode.Landed)).toBe(true);
    expect(a.modes.has(FlightMode.Normal)).toBe(true);
    // A replay from a state in the middle arrives at the same end as well.
    const mid = clone(start);
    for (let i = 0; i < 700; i++) simulateShip(mid, inputs[i]!, wisp, sys, T0 + i * DT, DT);
    const again = clone(mid);
    for (let i = 700; i < inputs.length; i++) {
      simulateShip(mid, inputs[i]!, wisp, sys, T0 + i * DT, DT);
      simulateShip(again, inputs[i]!, wisp, sys, T0 + i * DT, DT);
    }
    expect(mid).toEqual(a.s);
    expect(again).toEqual(a.s);
  });
});

describe('cruise near a landable body', () => {
  const ceiling = surface.ceiling;
  /** A ship in cruise in the frame of the planet, `height` above the ceiling, nose straight down. */
  function cruiser(height: number): ShipState {
    const s = newShipState(wisp);
    s.mode = FlightMode.Cruise;
    s.anchor = LANDING_PLANET;
    s.pos = v3.scale(v3.normalize([1, 1, -1]), ceiling + height);
    s.rot = quat.lookRotation(v3.neg(s.pos));
    s.cruiseSpeed = CRUISE_MIN_SPEED;
    return s;
  }

  it('limits the speed by the height above the ceiling, down to 250 m/s instead of 30 km/s', () => {
    const env = buildStepEnv(sys, LANDING_PLANET, T0);
    const at = (h: number): Vec3 => [0, ceiling + h, 0];
    expect(ceiling).toBe(LANDING_PLANET_RADIUS + terrainMax(surface.terrain) + 2000);
    expect(cruiseSpeedLimit(env, at(1e7), wisp)).toBeCloseTo(CRUISE_PROXIMITY_K * 1e7, 3);
    expect(cruiseSpeedLimit(env, at(50_000), wisp)).toBeCloseTo(CRUISE_PROXIMITY_K * 50_000, 6);
    expect(cruiseSpeedLimit(env, at(2000), wisp)).toBeCloseTo(CRUISE_PROXIMITY_K * 2000, 6);
    expect(cruiseSpeedLimit(env, at(100), wisp)).toBe(CRUISE_GROUND_MIN_SPEED);
    expect(cruiseSpeedLimit(env, at(-500), wisp)).toBe(CRUISE_GROUND_MIN_SPEED);
    expect(cruiseSpeedFloor(env, at(1e7))).toBe(CRUISE_MIN_SPEED);
    expect(cruiseSpeedFloor(env, at(50_000))).toBeCloseTo(CRUISE_PROXIMITY_K * 50_000, 6);
    expect(cruiseSpeedFloor(env, at(100))).toBe(CRUISE_GROUND_MIN_SPEED);
    // A body that cannot be landed on limits as it always did: by its surface, and never below 30 km/s.
    const giant = buildStepEnv(sys, LANDING_GIANT, T0);
    const r = sys.bodies[LANDING_GIANT]!.radius;
    expect(cruiseSpeedLimit(giant, [0, r + 1e7, 0], wisp)).toBeCloseTo(CRUISE_PROXIMITY_K * 1e7, 3);
    expect(cruiseSpeedLimit(giant, [0, r + 1000, 0], wisp)).toBe(CRUISE_MIN_SPEED);
    expect(cruiseSpeedFloor(giant, [0, r + 1000, 0])).toBe(CRUISE_MIN_SPEED);
  });

  it('lets a pilot fly down in cruise and ends cruise below the ceiling without harm', () => {
    const s = cruiser(60_000);
    const hull = s.hull;
    let drops = 0;
    let impact = 0;
    let droppedAt = -1;
    let before: Vec3 = [0, 0, 0];
    let speedAtDrop = 0;
    for (let i = 0; i < 60 / DT && s.mode === FlightMode.Cruise; i++) {
      const t = T0 + i * DT;
      before = absolutePosition(s, sys, t);
      speedAtDrop = s.cruiseSpeed;
      const env = simulateShip(s, NONE, wisp, sys, t, DT);
      impact = Math.max(impact, env.impact ?? 0);
      if (env.cruiseDrop) {
        drops++;
        droppedAt = i;
        expect(env.anchor).toBe(SURFACE);
        expect(env.ground).toBeDefined();
      }
      // On the way down the drive never runs faster than the height allows.
      if (s.mode === FlightMode.Cruise) expect(s.cruiseSpeed).toBeLessThanOrEqual(Math.max(CRUISE_GROUND_MIN_SPEED, CRUISE_PROXIMITY_K * (v3.len(s.pos) - ceiling) * 1.05 + 1));
    }
    expect(drops).toBe(1);
    expect(s.mode).toBe(FlightMode.Normal);
    expect(s.anchor).toBe(SURFACE);
    expect(s.cruiseSpeed).toBe(0);
    expect(speedAtDrop).toBe(CRUISE_GROUND_MIN_SPEED);
    // Just below the ceiling, 100 m/s along the nose over the ground, which still points down.
    expect(v3.len(s.pos)).toBeLessThan(ceiling);
    expect(v3.len(s.pos)).toBeGreaterThan(ceiling - 20);
    expect(v3.len(s.vel)).toBeCloseTo(CRUISE_EXIT_SPEED, 9);
    expect(v3.dist(s.vel, v3.scale(forwardOf(s.rot), CRUISE_EXIT_SPEED))).toBeLessThan(1e-9);
    expect(v3.dot(v3.normalize(s.vel), v3.normalize(s.pos))).toBeLessThan(-0.999);
    const t1 = T0 + (droppedAt + 1) * DT;
    expect(v3.dist(absolutePosition(s, sys, t1), v3.add(before, v3.scale(anchorState(sys, LANDING_PLANET, t1).vel, DT)))).toBeLessThan(20);
    expect(impact).toBe(0);
    expect(s.hull).toBe(hull);
    // The next tick is ordinary flight; the drop is reported once.
    expect(simulateShip(s, NONE, wisp, sys, t1, DT).cruiseDrop).toBeUndefined();
    // The throttle makes no difference this low: the height sets the speed either way.
    const fast = cruiser(60_000);
    let ticks = 0;
    let fastDrops = 0;
    while (fast.mode === FlightMode.Cruise && ticks < 60 / DT) {
      const env = simulateShip(fast, input({ throttle: 1 }), wisp, sys, T0 + ticks++ * DT, DT);
      if (env.cruiseDrop) fastDrops++;
      expect(env.impact ?? 0).toBe(0);
    }
    expect(fastDrops).toBe(1);
    expect(fast.mode).toBe(FlightMode.Normal);
    expect(Math.abs(ticks - 1 - droppedAt)).toBeLessThanOrEqual(1);
  });

  it('refuses to engage cruise below the ceiling and starts at the local limit just above it', () => {
    const below = shipAbove([0, 1, 0], 800);
    expect(bodyBelowCeiling(below, sys, T0)).toBe(LANDING_PLANET);
    expect(canEngageCruise(below, sys, T0)).toEqual({ ok: false, reason: 'ground' });
    // The same from the frame of the body, or of anything else.
    const other = clone(below);
    reanchor(other, sys, LANDING_STAR, T0);
    expect(canEngageCruise(other, sys, T0)).toEqual({ ok: false, reason: 'ground' });
    // The older reasons come first.
    expect(canEngageCruise({ ...below, fuel: 0 }, sys, T0)).toEqual({ ok: false, reason: 'fuel' });
    expect(canEngageCruise({ ...below, chargeKind: ChargeKind.Fold }, sys, T0)).toEqual({ ok: false, reason: 'charging' });
    expect(canEngageCruise({ ...below, mode: FlightMode.Landed }, sys, T0)).toEqual({ ok: false, reason: 'mode' });

    const above = shipAbove([0, 1, 0], 0);
    above.pos = v3.scale(v3.normalize(above.pos), ceiling + 3000);
    expect(bodyBelowCeiling(above, sys, T0)).toBe(-1);
    expect(canEngageCruise(above, sys, T0)).toEqual({ ok: true });
    engageCruise(above, sys, T0);
    expect(above.mode).toBe(FlightMode.Cruise);
    expect(above.anchor).toBe(LANDING_PLANET);
    expect(above.cruiseSpeed).toBeCloseTo(CRUISE_PROXIMITY_K * 3000, 3);
    expect(v3.dist(above.vel, v3.scale(forwardOf(above.rot), above.cruiseSpeed))).toBeLessThan(1e-9);
    // It does not drop straight back out, and climbing away it spools up.
    above.rot = quat.lookRotation(above.pos);
    const res = run(above, input({ throttle: 1 }), 10);
    expect(res.drops).toBe(0);
    expect(above.mode).toBe(FlightMode.Cruise);
    expect(above.cruiseSpeed).toBeGreaterThan(5000);
    // Far from any ground cruise starts at 30 km/s as before.
    const far = shipAbove([0, 1, 0], 0);
    far.anchor = LANDING_PLANET;
    far.pos = [0, 5e7, 0];
    engageCruise(far, sys, T0);
    expect(far.cruiseSpeed).toBe(CRUISE_MIN_SPEED);
  });

  it('drops a pilot who disengages low into the surface frame, at 100 m/s over the ground', () => {
    const s = cruiser(20_000);
    const res = disengageCruise(s, sys, T0);
    expect(res).toEqual({ anchor: SURFACE, emergency: false });
    expect(s.anchor).toBe(SURFACE);
    expect(s.mode).toBe(FlightMode.Normal);
    expect(v3.dist(s.vel, v3.scale(forwardOf(s.rot), CRUISE_EXIT_SPEED))).toBeLessThan(1e-9);
    // A site named in the request does not change that: this close to the ground the surface frame wins.
    const named = cruiser(20_000);
    expect(disengageCruise(named, sys, T0, LANDING_BASE).anchor).toBe(SURFACE);
    expect(disengageCruise(cruiser(20_000), sys, T0, LANDING_STATION).anchor).toBe(SURFACE);
    // High up it is the frame of the body, as it was.
    expect(disengageCruise(cruiser(600_000), sys, T0).anchor).toBe(LANDING_PLANET);

    // Even a station whose zone reaches down this far does not get the ship: the surface frame comes first.
    const low = landingSystem();
    const station = findSite(low, LANDING_STATION)!;
    station.orbit = { ...station.orbit, parent: LANDING_PLANET, a: LANDING_PLANET_RADIUS + 150_000, period: 5000 };
    const under = newShipState(wisp);
    under.mode = FlightMode.Cruise;
    under.anchor = LANDING_PLANET;
    const stationPos = v3.sub(anchorState(low, LANDING_STATION, T0).pos, anchorState(low, LANDING_PLANET, T0).pos);
    under.pos = v3.scale(v3.normalize(stationPos), LANDING_PLANET_RADIUS + 60_000);
    expect(disengageCruise(clone(under), low, T0, LANDING_STATION).anchor).toBe(SURFACE);
    // Beside the station, above the surface frame, the named site is honoured as before.
    under.pos = v3.scale(v3.normalize(stationPos), LANDING_PLANET_RADIUS + 260_000);
    expect(disengageCruise(clone(under), low, T0, LANDING_STATION).anchor).toBe(LANDING_STATION);
    expect(disengageCruise(clone(under), low, T0).anchor).toBe(LANDING_STATION);
  });

  it('has no exclusion radius at a landable body, and still has one everywhere else', () => {
    const low = newShipState(wisp);
    low.anchor = LANDING_PLANET;
    low.pos = [0, LANDING_PLANET_RADIUS * (BODY_EXCLUSION_FACTOR - 0.03), 0];
    expect(hazardsAt(buildStepEnv(sys, LANDING_PLANET, T0), low, wisp).insideBody).toBe(-1);
    low.anchor = SURFACE;
    const hz = hazardsAt(buildStepEnv(sys, SURFACE, T0), low, wisp);
    expect(hz.insideBody).toBe(-1);
    expect(hz.dominantBody).toBe(LANDING_PLANET);
    expect(hz.gravity).toBeCloseTo((G * LANDING_PLANET_MASS) / (low.pos[1] * low.pos[1]), 4);
    const giant = newShipState(wisp);
    giant.anchor = LANDING_GIANT;
    giant.pos = [0, sys.bodies[LANDING_GIANT]!.radius * (BODY_EXCLUSION_FACTOR - 0.01), 0];
    expect(hazardsAt(buildStepEnv(sys, LANDING_GIANT, T0), giant, wisp).insideBody).toBe(LANDING_GIANT);
    const star = newShipState(wisp);
    star.pos = [0, sys.bodies[LANDING_STAR]!.radius * 1.01, 0];
    expect(hazardsAt(buildStepEnv(sys, LANDING_STAR, T0), star, wisp).insideBody).toBe(LANDING_STAR);
    expect(SOLAR_MASS).toBeGreaterThan(0);
  });
});

describe('ground bases', () => {
  it('places a ship over the pad in the surface frame: at rest over the ground, level', () => {
    const headings: number[] = [];
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = newShipState(wisp);
      s.vel = [5, 5, 5];
      s.throttle = 0.7;
      s.charge = 0.5;
      s.chargeKind = ChargeKind.Cruise;
      placeAtSite(s, sys, LANDING_BASE, T0, new Rng(seed), 750);
      expect(s.mode).toBe(FlightMode.Normal);
      expect(s.anchor).toBe(SURFACE);
      expect(v3.dist(s.pos, PAD)).toBeCloseTo(750, 6);
      const rel = v3.sub(s.pos, PAD);
      const height = v3.dot(rel, PAD_UP);
      expect(height).toBeGreaterThan(700);
      expect(v3.len(v3.sub(rel, v3.scale(PAD_UP, height)))).toBeLessThanOrEqual(150 + 1e-6);
      expect(s.vel).toEqual([0, 0, 0]);
      expect(s.throttle).toBe(0);
      expect(s.chargeKind).toBe(ChargeKind.None);
      // Up along the pad normal, so the nose is level.
      expect(v3.dist(upOf(s.rot), PAD_UP)).toBeLessThan(1e-9);
      expect(Math.abs(v3.dot(forwardOf(s.rot), PAD_UP))).toBeLessThan(1e-9);
      const north = quat.rotate(groundSiteRotation(base), [0, 0, -1]);
      headings.push(v3.dot(forwardOf(s.rot), north));
      // It hovers there: same frame, same place, a second later.
      const where = v3.clone(s.pos);
      run(s, NONE, 1);
      expect(s.anchor).toBe(SURFACE);
      expect(v3.dist(s.pos, where)).toBeLessThan(1e-6);
    }
    expect(new Set(headings.map((h) => h.toFixed(3))).size).toBeGreaterThan(3);
    // Orbital sites and bodies are placed as before: in their own frame, nose toward them.
    const s = newShipState(wisp);
    placeAtSite(s, sys, LANDING_STATION, T0, new Rng(1), 2500);
    expect(s.anchor).toBe(LANDING_STATION);
    expect(v3.len(s.pos)).toBeCloseTo(2500, 6);
    expect(v3.dist(forwardOf(s.rot), v3.scale(v3.normalize(s.pos), -1))).toBeLessThan(1e-9);
    expect(() => placeAtSite(s, sys, LANDING_BASE + 5, T0, new Rng(1), 100)).toThrow();
  });

  it('mass-locks ships near a base, from whichever frame they are seen', () => {
    const near = shipAbove(PAD_UP, MASS_LOCK_RADIUS - 500);
    const far = shipAbove(PAD_UP, MASS_LOCK_RADIUS + 2500);
    expect(isMassLocked(near, sys, T0)).toBe(true);
    expect(isMassLocked(far, sys, T0)).toBe(false);
    for (const anchor of [LANDING_PLANET, LANDING_STAR]) {
      const a = clone(near);
      const b = clone(far);
      reanchor(a, sys, anchor, T0);
      reanchor(b, sys, anchor, T0);
      expect(isMassLocked(a, sys, T0)).toBe(true);
      expect(isMassLocked(b, sys, T0)).toBe(false);
    }
    // A docked ship has the base itself as its anchor.
    const docked = newShipState(wisp);
    docked.mode = FlightMode.Docked;
    docked.anchor = LANDING_BASE;
    expect(isMassLocked(docked, sys, T0)).toBe(true);
    // Near the base the mass lock is the reason given, further off the ground is.
    expect(canEngageCruise(near, sys, T0)).toEqual({ ok: false, reason: 'masslock' });
    expect(canEngageCruise(far, sys, T0)).toEqual({ ok: false, reason: 'ground' });
    // The station at the giant locks as it always did.
    const atStation = newShipState(wisp);
    atStation.anchor = LANDING_STATION;
    atStation.pos = [1000, 0, 0];
    expect(isMassLocked(atStation, sys, T0)).toBe(true);
    atStation.pos = [MASS_LOCK_RADIUS + 1, 0, 0];
    expect(canEngageCruise(atStation, sys, T0)).toEqual({ ok: true });
  });

  it('is never the frame a ship flies in', () => {
    const abs = v3.add(anchorState(sys, LANDING_BASE, T0).pos, [0, 0, 0]);
    expect(pickNormalAnchor(sys, abs, T0)).toBe(SURFACE);
    const env = buildStepEnv(sys, LANDING_BASE, T0);
    // The environment of a ship docked there is still that of its pad: the planet lies straight below.
    const planet = env.sources[LANDING_PLANET]!.pos;
    expect(v3.dist(planet, [0, -v3.len(PAD), 0])).toBeLessThan(1e-3);
    expect(env.ground).toBeUndefined();
    const docked = newShipState(wisp);
    docked.mode = FlightMode.Docked;
    docked.anchor = LANDING_BASE;
    const idle = simulateShip(docked, input({ thrust: [0, 1, 0] }), wisp, sys, T0, DT);
    expect(idle.sources).toEqual([]);
    expect(docked.mode).toBe(FlightMode.Docked);
    expect(docked.pos).toEqual([0, 0, 0]);
  });
});

describe('the wire format', () => {
  it('carries a landed ship in a surface frame: protocol version 4', () => {
    expect(PROTOCOL_VERSION).toBe(4);
    expect(FlightMode.Landed).toBe(5);
    expect(EntityFlag.Landed).toBe(128);
    const self = shipAbove(PAD_UP, 0);
    self.mode = FlightMode.Landed;
    const snapshot = decodeSnapshot(encodeSnapshot({
      tick: 7, ackSeq: 3, time: T0, self,
      ents: [{ id: 9, flags: EntityFlag.Landed | EntityFlag.Wanted, hull: 1, shield: 0.5, pos: [10, 0, -4], vel: [0, 0, 0], rot: [0, 0, 0, 1] }],
    }))!;
    expect(snapshot.self!.mode).toBe(FlightMode.Landed);
    expect(snapshot.self!.anchor).toBe(SURFACE);
    expect(snapshot.self!.pos).toEqual(self.pos);
    expect(snapshot.self!.rot).toEqual(self.rot);
    expect(snapshot.ents[0]!.flags).toBe(EntityFlag.Landed | EntityFlag.Wanted);
  });
});
