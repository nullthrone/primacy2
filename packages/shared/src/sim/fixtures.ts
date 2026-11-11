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
  SITE_ID_BASE,
  SOLAR_LUMINOSITY,
  SOLAR_MASS,
  SOLAR_RADIUS,
  SOLAR_TEMP,
} from '../constants.ts';
import { circularOrbit } from '../universe/orbits.ts';
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
