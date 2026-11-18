/**
 * Small hand-built star systems for simulation tests. They are independent of the procedural
 * generator, so flight-model tests keep working whatever the generator produces.
 */
import {
  AU,
  C,
  DEFAULT_SITE_FRAME_RADIUS,
  EARTH_MASS,
  EARTH_RADIUS,
  G,
  JUPITER_MASS,
  JUPITER_RADIUS,
  SITE_ID_BASE,
  SOLAR_LUMINOSITY,
  SOLAR_MASS,
  SOLAR_RADIUS,
  SOLAR_TEMP,
} from '../constants.ts';
import { circularOrbit } from '../universe/orbits.ts';
import { terrainHeight, terrainParams } from '../universe/terrain.ts';
import type { BodyDef, SiteDef, SystemDef } from '../universe/types.ts';

/** Body ids of the fixture systems. */
export const FIXTURE_STAR = 0;
export const FIXTURE_PLANET = 1;
export const FIXTURE_MOON = 2;
/** Anchor id of the station orbiting the fixture planet. */
export const FIXTURE_STATION = SITE_ID_BASE;
/** Anchor id of a navigation beacon orbiting the fixture planet (not a mass-locking structure). */
export const FIXTURE_BEACON = SITE_ID_BASE + 1;

/** Radius of the station's circular orbit around the planet, metres. */
export const FIXTURE_STATION_ORBIT = 7.0e6;
/** Radius of the beacon's circular orbit around the planet, metres. */
export const FIXTURE_BEACON_ORBIT = 2.0e7;
/** Radius of the moon's circular orbit around the planet, metres. */
export const FIXTURE_MOON_ORBIT = 3.844e8;
export const FIXTURE_MOON_MASS = 7.342e22;
export const FIXTURE_MOON_RADIUS = 1.7374e6;

/** Mass of the black hole in `blackHoleSystem`, kilograms. */
export const FIXTURE_BH_MASS = 10 * SOLAR_MASS;
/** Schwarzschild radius of the fixture black hole, metres (about 29.5 km). */
export const FIXTURE_BH_RS = (2 * G * FIXTURE_BH_MASS) / (C * C);

const body = (partial: Pick<BodyDef, 'id' | 'name' | 'kind' | 'cls' | 'mass' | 'radius' | 'orbit'> & Partial<BodyDef>): BodyDef => ({
  rotPeriod: 86_400,
  tilt: 0,
  seed: partial.id + 1,
  color: 0xffffff,
  temp: 288,
  ...partial,
});

/**
 * A Sun-like G star (body 0), an Earth-like planet (body 1) on a circular 1 AU orbit, a moon
 * (body 2), a station (`FIXTURE_STATION`) on a 7000 km circular orbit around the planet with a
 * 250 km frame radius, and a beacon (`FIXTURE_BEACON`) on a 20 000 km orbit.
 * At t = 0 the planet is at [1 AU, 0, 0]; every orbit lies in the XZ plane.
 */
export function fixtureSystem(): SystemDef {
  const bodies: BodyDef[] = [
    body({
      id: FIXTURE_STAR, name: 'Fixture', kind: 'star', cls: 'G', mass: SOLAR_MASS, radius: SOLAR_RADIUS, orbit: null,
      temp: SOLAR_TEMP, lum: SOLAR_LUMINOSITY, color: 0xfff4e0, scoopable: true,
    }),
    body({
      id: FIXTURE_PLANET, name: 'Fixture I', kind: 'planet', cls: 'terran', mass: EARTH_MASS, radius: EARTH_RADIUS,
      orbit: circularOrbit(FIXTURE_STAR, SOLAR_MASS, AU, 0), color: 0x3f6fb0, habitable: true,
    }),
    body({
      id: FIXTURE_MOON, name: 'Fixture I a', kind: 'moon', cls: 'rocky', mass: FIXTURE_MOON_MASS,
      radius: FIXTURE_MOON_RADIUS, orbit: circularOrbit(FIXTURE_PLANET, EARTH_MASS, FIXTURE_MOON_ORBIT, 2.0),
      color: 0x9a9a9a, temp: 220,
    }),
  ];
  const sites: SiteDef[] = [
    {
      id: FIXTURE_STATION, kind: 'station', name: 'Fixture Station',
      orbit: circularOrbit(FIXTURE_PLANET, EARTH_MASS, FIXTURE_STATION_ORBIT, 0.7),
      frameRadius: DEFAULT_SITE_FRAME_RADIUS, seed: 11, model: 'station_ring', radius: 400,
      services: ['market', 'repair', 'refuel'], economy: 'industrial',
    },
    {
      id: FIXTURE_BEACON, kind: 'beacon', name: 'Fixture Beacon',
      orbit: circularOrbit(FIXTURE_PLANET, EARTH_MASS, FIXTURE_BEACON_ORBIT, 3.1),
      frameRadius: DEFAULT_SITE_FRAME_RADIUS, seed: 12, model: 'beacon', radius: 20,
    },
  ];
  return {
    id: 'fixture:0', name: 'Fixture', pos: [0, 0, 0], starClass: 'G', security: 'secure', stations: 1, tags: [],
    seed: 1, bodies, belts: [], sites,
  };
}

/**
 * A 10 solar-mass black hole as body 0 (rs = 2GM/c^2, radius = rs, no luminosity) with one
 * rocky planet on a circular 1 AU orbit so that sphere-of-influence logic has something to find.
 */
export function blackHoleSystem(): SystemDef {
  const bodies: BodyDef[] = [
    body({
      id: FIXTURE_STAR, name: 'Fixture Abyss', kind: 'star', cls: 'BH', mass: FIXTURE_BH_MASS, radius: FIXTURE_BH_RS,
      orbit: null, temp: 0, lum: 0, rs: FIXTURE_BH_RS, color: 0x000000,
    }),
    body({
      id: FIXTURE_PLANET, name: 'Fixture Abyss I', kind: 'planet', cls: 'rocky', mass: EARTH_MASS, radius: EARTH_RADIUS,
      orbit: circularOrbit(FIXTURE_STAR, FIXTURE_BH_MASS, AU, 0), color: 0x6b5a4a, temp: 40,
    }),
  ];
  return {
    id: 'fixture:1', name: 'Fixture Abyss', pos: [3, 0, 0], starClass: 'BH', security: 'lawless', stations: 0,
    tags: ['blackhole'], seed: 2, bodies, belts: [], sites: [],
  };
}

/** Body ids of `landingSystem`. */
export const LANDING_STAR = 0;
/** A rocky, airless planet that turns once in four hours: its ground moves at over 1,000 m/s at the equator. */
export const LANDING_PLANET = 1;
/** A small ice moon of the planet, tidally locked. */
export const LANDING_MOON = 2;
/** A gas giant, which cannot be landed on, with a station in orbit. */
export const LANDING_GIANT = 3;
/** Anchor ids of the station at the giant and of the ground base on the planet. */
export const LANDING_STATION = SITE_ID_BASE;
export const LANDING_BASE = SITE_ID_BASE + 1;

export const LANDING_PLANET_RADIUS = 2.4e6;
export const LANDING_PLANET_MASS = 0.05 * EARTH_MASS;
export const LANDING_PLANET_DAY = 4 * 3600;
export const LANDING_MOON_RADIUS = 4.0e5;
export const LANDING_MOON_MASS = 7.2e20;
export const LANDING_MOON_ORBIT = 6.0e7;
/** Unit direction of the ground base on the planet, in body-fixed axes. */
export const LANDING_BASE_DIR: readonly [number, number, number] = [0.6, 0.48, 0.64];

/**
 * A system for flight near the ground: a G star (body 0), a rocky airless planet (body 1, landable,
 * surface gravity about 3.5 m/s^2, a four-hour day, axis tilted by 0.3 rad), its ice moon (body 2,
 * landable), a gas giant (body 3) with a station (`LANDING_STATION`), and a ground base
 * (`LANDING_BASE`) on the planet at `LANDING_BASE_DIR`.
 */
export function landingSystem(): SystemDef {
  const planet = body({
    id: LANDING_PLANET, name: 'Lander I', kind: 'planet', cls: 'rocky', mass: LANDING_PLANET_MASS, radius: LANDING_PLANET_RADIUS,
    orbit: circularOrbit(LANDING_STAR, SOLAR_MASS, AU, 0.4), rotPeriod: LANDING_PLANET_DAY, tilt: 0.3, seed: 0x5eed1, color: 0x8a7f72, temp: 250,
  });
  const moonOrbit = circularOrbit(LANDING_PLANET, LANDING_PLANET_MASS, LANDING_MOON_ORBIT, 1.1, 0.3, 0);
  const bodies: BodyDef[] = [
    body({
      id: LANDING_STAR, name: 'Lander', kind: 'star', cls: 'G', mass: SOLAR_MASS, radius: SOLAR_RADIUS, orbit: null,
      temp: SOLAR_TEMP, lum: SOLAR_LUMINOSITY, color: 0xfff4e0, scoopable: true,
    }),
    planet,
    body({
      id: LANDING_MOON, name: 'Lander I a', kind: 'moon', cls: 'ice', mass: LANDING_MOON_MASS, radius: LANDING_MOON_RADIUS,
      orbit: moonOrbit, rotPeriod: moonOrbit.period, tilt: 0.3, seed: 0x5eed2, color: 0xdfe8ee, temp: 120,
    }),
    body({
      id: LANDING_GIANT, name: 'Lander II', kind: 'planet', cls: 'gas', mass: JUPITER_MASS, radius: JUPITER_RADIUS,
      orbit: circularOrbit(LANDING_STAR, SOLAR_MASS, 5 * AU, 2.2), color: 0xc8a878, temp: 130,
      atmo: { height: 4e5, color: 0xc8a878, density: 1 },
    }),
  ];
  // The pad lies at the height the untouched ground has at its centre.
  const dir = LANDING_BASE_DIR;
  const r = LANDING_PLANET_RADIUS + terrainHeight(terrainParams(planet), dir[0], dir[1], dir[2]);
  const sites: SiteDef[] = [
    {
      id: LANDING_STATION, kind: 'station', name: 'Lander Station',
      orbit: circularOrbit(LANDING_GIANT, JUPITER_MASS, 2.5 * JUPITER_RADIUS, 0.3),
      frameRadius: DEFAULT_SITE_FRAME_RADIUS, seed: 21, model: 'station_ring', radius: 400,
      services: ['market', 'repair', 'refuel'], economy: 'refinery',
    },
    {
      id: LANDING_BASE, kind: 'base', name: 'Lander Ground',
      orbit: { parent: LANDING_PLANET, a: 0, e: 0, inc: 0, node: 0, argp: 0, m0: 0, period: 0 },
      frameRadius: 0, seed: 22, radius: 250,
      services: ['market', 'refuel', 'repair', 'missions'], economy: 'mining',
      ground: { body: LANDING_PLANET, pos: [dir[0] * r, dir[1] * r, dir[2] * r] },
    },
  ];
  return {
    id: 'fixture:2', name: 'Lander', pos: [6, 0, 0], starClass: 'G', security: 'secure', stations: 1, tags: [],
    seed: 3, bodies, belts: [], sites,
  };
}
