import { describe, expect, it } from 'vitest';
import { ECONOMIES } from '../catalog.ts';
import {
  AU, C, DEFAULT_SITE_FRAME_RADIUS, EARTH_MASS, EARTH_RADIUS, FOLD_ARRIVAL_MIN, FOLD_ARRIVAL_RADII, G, JUPITER_MASS,
  MAX_SYSTEMS_PER_SECTOR, SITE_ID_BASE, SOLAR_LUMINOSITY, SOLAR_MASS,
} from '../constants.ts';
import { v3, type Vec3 } from '../math.ts';
import {
  ANOMALY_MAX_GRAVITY, BEACON_FRAME_RADIUS, BELT_SITE_FRAME_RADIUS, bodySpinAxis, generateSector, generateSystem,
  RING_SITE_FRAME_RADIUS, sectorFactions, sectorOffsets, sectorSystemNames, systemEdgeFraction,
} from './generate.ts';
import { orbitalPeriod, orbitState, soiRadius } from './orbits.ts';
import type { BodyDef, SiteDef, StarClass, SystemDef } from './types.ts';

const SIGMA = 5.670374419e-8;
const DEG = Math.PI / 180;
const RADIUS = 18;

const SERVERS = ['aaaaaaaaaaaaaaaa', 'bcdefghijklmnopq', 'q2w3e4r5t6y7abcd', 'zzzzyyyyxxxxwwww', 'mnbvcxzlkjhgfdsa', 'primacytwoserver'];
const SEEDS = ['primacy', 'second-seed', '', 'Übergröße', '12345', 'the quick brown fox'];
const CENTERS: Vec3[] = [[0, 0, 0], [120, -4, 33], [-75.5, 2.25, 190], [10, 0, -5], [0, 11, 0], [-200, -9, -60]];

const sectorOf = (k: number, count = 16): SystemDef[] =>
  generateSector({ serverId: SERVERS[k]!, seed: SEEDS[k]!, center: CENTERS[k]!, radius: RADIUS, count });

/** Six different sectors of 16 systems each. */
const SECTORS: SystemDef[][] = SERVERS.map((_, k) => sectorOf(k));
const SYSTEMS: SystemDef[] = SECTORS.flat();

/** Twelve full sectors for anything statistical. */
const MANY: SystemDef[] = [];
for (let k = 0; k < 12; k++) {
  MANY.push(...generateSector({ serverId: `statserver${k}`, seed: `stat${k}`, center: [0, 0, 0], radius: RADIUS, count: 64 }));
}

const hill = (b: BodyDef, parentMass: number): number => b.orbit!.a * (1 - b.orbit!.e) * Math.cbrt(b.mass / (3 * parentMass));
const peri = (b: { orbit: { a: number; e: number } | null }): number => b.orbit!.a * (1 - b.orbit!.e);
const apo = (b: { orbit: { a: number; e: number } | null }): number => b.orbit!.a * (1 + b.orbit!.e);
const isGiant = (b: BodyDef): boolean => b.cls === 'gas' || b.cls === 'icegiant';
const planetsOf = (sys: SystemDef): BodyDef[] => sys.bodies.filter((b) => b.kind === 'planet');
const moonsOf = (sys: SystemDef, planet: BodyDef): BodyDef[] => sys.bodies.filter((b) => b.kind === 'moon' && b.orbit!.parent === planet.id);
const arrivalDistance = (sys: SystemDef): number => Math.max(FOLD_ARRIVAL_RADII * sys.bodies[0]!.radius, FOLD_ARRIVAL_MIN);
const equilibriumTemp = (sys: SystemDef, a: number): number =>
  (278 * (sys.bodies[0]!.lum! / SOLAR_LUMINOSITY) ** 0.25) / Math.sqrt(a / AU);

/** Calls `visit` for every number anywhere inside `value`. */
function eachNumber(value: unknown, path: string, visit: (n: number, path: string) => void): void {
  if (typeof value === 'number') visit(value, path);
  else if (Array.isArray(value)) value.forEach((v, i) => eachNumber(v, `${path}[${i}]`, visit));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) eachNumber(v, `${path}.${k}`, visit);
  }
}

describe('determinism', () => {
  it('generates deep-equal sectors from equal parameters', () => {
    for (let k = 0; k < SERVERS.length; k++) {
      const again = sectorOf(k);
      expect(again).toEqual(SECTORS[k]);
      expect(JSON.stringify(again)).toBe(JSON.stringify(SECTORS[k]));
    }
  });

  it('does not depend on how many systems are generated', () => {
    for (let k = 0; k < SERVERS.length; k++) {
      expect(sectorOf(k, 8)).toEqual(SECTORS[k]!.slice(0, 8));
    }
    const full = generateSector({ serverId: SERVERS[0]!, seed: SEEDS[0]!, center: CENTERS[0]!, radius: RADIUS, count: 64 });
    expect(full.slice(0, 16)).toEqual(SECTORS[0]);
  });

  it('generateSystem reproduces the system generateSector made', () => {
    for (let k = 0; k < 3; k++) {
      const offsets = sectorOffsets(SERVERS[k]!, SEEDS[k]!, RADIUS, 16);
      SECTORS[k]!.forEach((sys, i) => {
        const pos = v3.add(CENTERS[k]!, offsets[i]!);
        expect(sys.pos).toEqual(pos);
        expect(generateSystem(SERVERS[k]!, SEEDS[k]!, i, pos)).toEqual(sys);
      });
    }
  });

  it('gives different sectors for a different seed or server id', () => {
    const base = SECTORS[0]!;
    const otherSeed = generateSector({ serverId: SERVERS[0]!, seed: 'another seed', center: CENTERS[0]!, radius: RADIUS, count: 16 });
    const otherServer = generateSector({ serverId: SERVERS[1]!, seed: SEEDS[0]!, center: CENTERS[0]!, radius: RADIUS, count: 16 });
    for (const other of [otherSeed, otherServer]) {
      expect(other.map((s) => s.name)).not.toEqual(base.map((s) => s.name));
      expect(other.map((s) => s.pos)).not.toEqual(base.map((s) => s.pos));
      expect(other.map((s) => s.bodies.length)).not.toEqual(base.map((s) => s.bodies.length));
    }
  });

  it('only shifts positions when the centre moves', () => {
    const moved = generateSector({ serverId: SERVERS[0]!, seed: SEEDS[0]!, center: [50, 5, -50], radius: RADIUS, count: 16 });
    moved.forEach((sys, i) => {
      const original = SECTORS[0]![i]!;
      expect(v3.dist(v3.sub(sys.pos, [50, 5, -50]), v3.sub(original.pos, CENTERS[0]!))).toBeLessThan(1e-9);
      expect({ ...sys, pos: null }).toEqual({ ...original, pos: null });
    });
  });

  it('rejects system counts outside 1..MAX_SYSTEMS_PER_SECTOR', () => {
    const p = { serverId: SERVERS[0]!, seed: 's', center: [0, 0, 0] as Vec3, radius: RADIUS };
    expect(() => generateSector({ ...p, count: 0 })).toThrow(RangeError);
    expect(() => generateSector({ ...p, count: MAX_SYSTEMS_PER_SECTOR + 1 })).toThrow(RangeError);
    expect(() => generateSector({ ...p, count: 2.5 })).toThrow(RangeError);
    expect(generateSector({ ...p, count: MAX_SYSTEMS_PER_SECTOR })).toHaveLength(MAX_SYSTEMS_PER_SECTOR);
    expect(() => generateSystem(SERVERS[0]!, 's', -1, [0, 0, 0])).toThrow(RangeError);
  });
});

describe('sanity of generated sectors', () => {
  it('numbers systems and keeps them inside the sector', () => {
    SECTORS.forEach((sector, k) => {
      expect(sector).toHaveLength(16);
      sector.forEach((sys, i) => {
        expect(sys.id).toBe(`${SERVERS[k]}:${i}`);
        expect(v3.dist(sys.pos, CENTERS[k]!)).toBeLessThanOrEqual(RADIUS);
        expect(sys.starClass).toBe(sys.bodies[0]!.cls);
        expect(Number.isInteger(sys.seed) && sys.seed >= 0 && sys.seed <= 0xffffffff).toBe(true);
      });
      expect(new Set(sector.map((s) => s.seed)).size).toBe(16);
    });
  });

  it('contains only finite numbers and survives a JSON round trip', () => {
    let count = 0;
    for (const sys of [...SYSTEMS, ...MANY]) {
      eachNumber(sys, sys.id, (n, path) => {
        count++;
        if (!Number.isFinite(n)) throw new Error(`${path} is ${n}`);
      });
    }
    expect(count).toBeGreaterThan(10_000);
    for (const sys of SYSTEMS) expect(JSON.parse(JSON.stringify(sys))).toEqual(sys);
  });

  it('lists parents before children, with body ids equal to their index', () => {
    for (const sys of [...SYSTEMS, ...MANY]) {
      expect(sys.bodies.length).toBeGreaterThanOrEqual(1);
      expect(sys.bodies.length).toBeLessThan(SITE_ID_BASE);
      sys.bodies.forEach((b, i) => {
        expect(b.id).toBe(i);
        if (i === 0) {
          expect(b.kind).toBe('star');
          expect(b.orbit).toBeNull();
          return;
        }
        expect(b.orbit).not.toBeNull();
        const parent = sys.bodies[b.orbit!.parent]!;
        expect(b.orbit!.parent).toBeLessThan(i);
        expect(b.orbit!.parent).toBeGreaterThanOrEqual(0);
        // Stars and planets orbit the primary, moons orbit a planet.
        if (b.kind === 'moon') expect(parent.kind).toBe('planet');
        else expect(b.orbit!.parent).toBe(0);
        expect(b.mass).toBeLessThan(parent.mass);
      });
    }
  });

  it('gives every body physical values', () => {
    for (const sys of [...SYSTEMS, ...MANY]) {
      for (const b of sys.bodies) {
        expect(b.mass).toBeGreaterThan(0);
        expect(b.radius).toBeGreaterThan(0);
        expect(b.temp).toBeGreaterThan(0);
        expect(b.rotPeriod).not.toBe(0);
        expect(b.tilt).toBeGreaterThanOrEqual(0);
        expect(b.tilt).toBeLessThan(Math.PI / 2);
        expect(Number.isInteger(b.seed) && b.seed >= 0 && b.seed <= 0xffffffff).toBe(true);
        expect(Number.isInteger(b.color) && b.color >= 0 && b.color <= 0xffffff).toBe(true);
        if (b.orbit) {
          const o = b.orbit;
          expect(o.a).toBeGreaterThan(0);
          expect(o.e).toBeGreaterThanOrEqual(0);
          expect(o.e).toBeLessThan(0.1);
          expect(o.inc).toBeGreaterThanOrEqual(0);
          expect(o.period).toBeGreaterThan(0);
          // Nothing dips into its parent.
          expect(peri(b)).toBeGreaterThan(sys.bodies[o.parent]!.radius * 2.9);
        }
      }
    }
  });

  it('derives every orbital period from the third law of Kepler', () => {
    for (const sys of [...SYSTEMS, ...MANY]) {
      for (const b of sys.bodies) {
        if (b.orbit) expect(b.orbit.period).toBe(orbitalPeriod(b.orbit.a, sys.bodies[b.orbit.parent]!.mass));
      }
      for (const site of sys.sites) {
        expect(site.orbit.period).toBe(orbitalPeriod(site.orbit.a, sys.bodies[site.orbit.parent]!.mass));
      }
    }
  });

  it('spaces planet orbits geometrically so they never cross', () => {
    let pairs = 0;
    for (const sys of [...SYSTEMS, ...MANY]) {
      const star = sys.bodies[0]!;
      const planets = planetsOf(sys);
      expect(planets.length).toBeLessThanOrEqual(9);
      for (let i = 0; i < planets.length; i++) {
        const p = planets[i]!;
        expect(p.orbit!.e).toBeLessThanOrEqual(0.08);
        expect(p.orbit!.inc).toBeLessThanOrEqual(4 * DEG);
        expect(peri(p)).toBeGreaterThanOrEqual(3 * star.radius);
        if (i === 0) continue;
        const inner = planets[i - 1]!;
        pairs++;
        // Listed from the inside out, periapsis beyond the apoapsis of the previous one.
        expect(peri(p)).toBeGreaterThan(apo(inner));
        expect(p.orbit!.a / inner.orbit!.a).toBeGreaterThanOrEqual(1.4 - 1e-9);
        // Their Hill spheres stay apart as well.
        expect(peri(p) - hill(p, star.mass)).toBeGreaterThan(apo(inner) + hill(inner, star.mass));
      }
    }
    expect(pairs).toBeGreaterThan(500);
  });

  it('keeps moons inside the Hill sphere and outside the Roche limit and the rings', () => {
    let moons = 0;
    for (const sys of [...SYSTEMS, ...MANY]) {
      const star = sys.bodies[0]!;
      for (const planet of planetsOf(sys)) {
        const list = moonsOf(sys, planet);
        expect(list.length).toBeLessThanOrEqual(isGiant(planet) ? 4 : 1);
        const limit = hill(planet, star.mass);
        const planetDensity = planet.mass / ((4 / 3) * Math.PI * planet.radius ** 3);
        list.forEach((moon, k) => {
          moons++;
          const moonDensity = moon.mass / ((4 / 3) * Math.PI * moon.radius ** 3);
          const roche = 2.44 * planet.radius * Math.cbrt(planetDensity / moonDensity);
          expect(apo(moon)).toBeLessThanOrEqual(limit / 3);
          expect(peri(moon)).toBeGreaterThan(roche);
          expect(peri(moon)).toBeGreaterThan(4 * planet.radius);
          if (planet.rings) expect(peri(moon)).toBeGreaterThan(planet.rings.outer * 1.2);
          expect(moon.mass).toBeLessThan(0.02 * planet.mass);
          // Tidally locked, in the equatorial plane of the planet.
          expect(moon.rotPeriod).toBe(moon.orbit!.period);
          expect(Math.abs(moon.orbit!.inc - planet.tilt)).toBeLessThanOrEqual(0.011);
          if (k > 0) expect(peri(moon)).toBeGreaterThan(apo(list[k - 1]!));
        });
      }
    }
    expect(moons).toBeGreaterThan(500);
  });

  it('places belts in gaps between the planets', () => {
    let belts = 0;
    for (const sys of [...SYSTEMS, ...MANY]) {
      expect(sys.belts.length).toBeLessThanOrEqual(2);
      const star = sys.bodies[0]!;
      sys.belts.forEach((belt, i) => {
        belts++;
        expect(belt.id).toBe(i);
        expect(belt.parent).toBe(0);
        expect(belt.inner).toBeGreaterThan(3 * star.radius);
        expect(belt.outer).toBeGreaterThan(belt.inner * 1.1);
        expect(belt.height).toBeGreaterThan(0);
        expect(belt.height).toBeLessThan(belt.outer - belt.inner);
        expect(['rock', 'metal', 'ice']).toContain(belt.kind);
        expect(belt.richness).toBeGreaterThanOrEqual(0.2);
        expect(belt.richness).toBeLessThanOrEqual(1);
        for (const p of planetsOf(sys)) {
          const h = hill(p, star.mass);
          const clear = apo(p) + h < belt.inner || peri(p) - h > belt.outer;
          expect(clear, `${p.name} crosses ${belt.name}`).toBe(true);
        }
        if (i > 0) expect(belt.inner).toBeGreaterThan(sys.belts[i - 1]!.outer);
      });
    }
    expect(belts).toBeGreaterThan(300);
  });

  it('keeps the fold arrival shell clear of planets', () => {
    for (const sys of [...SYSTEMS, ...MANY]) {
      const d = arrivalDistance(sys);
      const star = sys.bodies[0]!;
      for (const p of planetsOf(sys)) {
        const h = hill(p, star.mass);
        const crosses = peri(p) - h < d * 1.1 && apo(p) + h > d * 0.95;
        expect(crosses, `${p.name} at ${p.orbit!.a} m, arrival at ${d} m`).toBe(false);
      }
    }
  });

  it('gives every site the id SITE_ID_BASE + index and an existing parent', () => {
    for (const sys of [...SYSTEMS, ...MANY]) {
      expect(sys.sites.length).toBeGreaterThan(0);
      sys.sites.forEach((site, i) => {
        expect(site.id).toBe(SITE_ID_BASE + i);
        expect(Number.isInteger(site.orbit.parent)).toBe(true);
        expect(sys.bodies[site.orbit.parent]).toBeDefined();
        expect(site.orbit.e).toBe(0);
        if (site.ground) {
          // A ground base stands on its body: no orbit and no zone of its own.
          expect(site.frameRadius).toBe(0);
          expect(site.orbit.a).toBe(0);
        } else {
          expect(site.frameRadius).toBeGreaterThan(0);
          expect(site.orbit.a).toBeGreaterThan(sys.bodies[site.orbit.parent]!.radius);
        }
        expect(Number.isInteger(site.seed) && site.seed >= 0 && site.seed <= 0xffffffff).toBe(true);
      });
    }
  });

  it('uses non-empty names that are unique within a system', () => {
    for (const sys of [...SYSTEMS, ...MANY]) {
      const names = [...sys.bodies.map((b) => b.name), ...sys.belts.map((b) => b.name), ...sys.sites.map((s) => s.name)];
      for (const n of names) {
        expect(typeof n).toBe('string');
        expect(n.trim().length).toBeGreaterThan(0);
        expect(n.length).toBeLessThanOrEqual(48);
      }
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('names bodies after their system', () => {
    for (const sys of SYSTEMS) {
      expect(sys.bodies[0]!.name).toBe(sys.name);
      const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];
      planetsOf(sys).forEach((planet, i) => {
        expect(planet.name).toBe(`${sys.name} ${roman[i]}`);
        moonsOf(sys, planet).forEach((moon, k) => expect(moon.name).toBe(`${planet.name} ${'abcd'[k]}`));
      });
      for (const b of sys.bodies) if (b.kind === 'star' && b.id > 0) expect(b.name).toBe(`${sys.name} B`);
    }
  });

  it('gives systems pronounceable names of 4 to 12 letters, unique within a sector', () => {
    for (let k = 0; k < 12; k++) {
      const names = MANY.slice(k * 64, (k + 1) * 64).map((s) => s.name);
      expect(new Set(names).size).toBe(64);
      for (const n of names) expect(n).toMatch(/^[A-Z][a-z]{3,11}$/);
      expect(sectorSystemNames(`statserver${k}`, `stat${k}`, 64)).toEqual(names);
      expect(sectorSystemNames(`statserver${k}`, `stat${k}`, 10)).toEqual(names.slice(0, 10));
    }
  });

  it('tags systems with what they contain', () => {
    const allowed = ['capital', 'blackhole', 'neutron', 'whitedwarf', 'binary', 'belt', 'rings', 'habitable', 'giant', 'gate'];
    for (const sys of [...SYSTEMS, ...MANY]) {
      expect(sys.tags.length).toBeLessThanOrEqual(12);
      expect(new Set(sys.tags).size).toBe(sys.tags.length);
      for (const t of sys.tags) expect(allowed).toContain(t);
      const stars = sys.bodies.filter((b) => b.kind === 'star');
      const has = (t: string): boolean => sys.tags.includes(t);
      expect(has('capital')).toBe(sys.id.endsWith(':0'));
      expect(has('blackhole')).toBe(stars.some((b) => b.cls === 'BH'));
      expect(has('neutron')).toBe(stars.some((b) => b.cls === 'NS'));
      expect(has('whitedwarf')).toBe(stars.some((b) => b.cls === 'WD'));
      expect(has('binary')).toBe(stars.length > 1);
      expect(has('belt')).toBe(sys.belts.length > 0);
      expect(has('rings')).toBe(sys.bodies.some((b) => b.rings !== undefined));
      expect(has('habitable')).toBe(sys.bodies.some((b) => b.habitable === true));
      expect(has('giant')).toBe(sys.bodies.some(isGiant));
      expect(has('gate')).toBe(false);
    }
  });

  it('counts dockable sites and assigns one of the sector factions', () => {
    for (const sys of [...SYSTEMS, ...MANY]) {
      const serverId = sys.id.split(':')[0]!;
      const dockable = sys.sites.filter((s) => s.kind === 'station' || s.kind === 'outpost');
      expect(sys.stations).toBe(dockable.length);
      expect(sys.stations).toBeLessThanOrEqual(64);
      if (dockable.length === 0) {
        expect(sys.faction).toBeUndefined();
        // Nobody patrols a system without a station.
        expect(sys.security).not.toBe('secure');
      }
    }
    for (let k = 0; k < 12; k++) {
      const factions = sectorFactions(`statserver${k}`, `stat${k}`);
      expect(factions.length === 2 || factions.length === 3).toBe(true);
      expect(new Set(factions).size).toBe(factions.length);
      for (const sys of MANY.slice(k * 64, (k + 1) * 64)) {
        if (sys.stations > 0) expect(factions).toContain(sys.faction);
        for (const site of sys.sites) {
          // Ground bases belong to the faction of their system, like its stations.
          if (site.kind === 'station' || site.kind === 'outpost' || site.kind === 'base') expect(factions).toContain(site.faction);
          else expect(site.faction).toBeUndefined();
        }
      }
      expect(MANY[k * 64]!.faction).toBe(factions[0]);
    }
  });
});

describe('stars', () => {
  const primaries = MANY.map((s) => s.bodies[0]!);
  const allStars = MANY.flatMap((s) => s.bodies.filter((b) => b.kind === 'star'));

  /** Mass (solar) and temperature (K) ranges of the main-sequence classes. */
  const BANDS: Record<string, { mass: [number, number]; temp: [number, number] }> = {
    M: { mass: [0.08, 0.45], temp: [2400, 3700] },
    K: { mass: [0.45, 0.8], temp: [3700, 5200] },
    G: { mass: [0.8, 1.04], temp: [5200, 6000] },
    F: { mass: [1.04, 1.4], temp: [6000, 7500] },
    A: { mass: [1.4, 2.1], temp: [7500, 10_000] },
    B: { mass: [2.1, 16], temp: [10_000, 30_000] },
    O: { mass: [16, 60], temp: [30_000, 45_000] },
  };

  it('draws classes from a realistic distribution', () => {
    const count: Record<string, number> = {};
    // The showcase indices are fixed, so leave them out.
    MANY.forEach((s, i) => {
      if (![0, 3, 5].includes(i % 64)) count[s.starClass] = (count[s.starClass] ?? 0) + 1;
    });
    const n = (c: StarClass): number => count[c] ?? 0;
    expect(n('M')).toBeGreaterThan(n('K'));
    expect(n('K')).toBeGreaterThan(n('G'));
    expect(n('G')).toBeGreaterThan(n('F'));
    expect(n('F')).toBeGreaterThan(n('A'));
    expect(n('A')).toBeGreaterThan(n('B'));
    expect(n('WD')).toBeGreaterThan(n('B'));
    expect(n('B')).toBeGreaterThan(n('O'));
    expect(n('M') / (MANY.length - 36)).toBeGreaterThan(0.3);
    expect(n('M') / (MANY.length - 36)).toBeLessThan(0.5);
    expect(n('NS') + n('BH')).toBeGreaterThan(0);
    expect((n('NS') + n('BH')) / (MANY.length - 36)).toBeLessThan(0.1);
    expect(n('O') / (MANY.length - 36)).toBeLessThan(0.03);
  });

  it('keeps mass, radius, temperature and luminosity of main-sequence stars consistent', () => {
    let checked = 0;
    for (const star of allStars) {
      const band = BANDS[star.cls];
      if (!band) continue;
      checked++;
      const m = star.mass / SOLAR_MASS;
      expect(m).toBeGreaterThanOrEqual(band.mass[0]);
      expect(m).toBeLessThanOrEqual(band.mass[1]);
      expect(star.temp).toBeGreaterThanOrEqual(band.temp[0] - 1e-6);
      expect(star.temp).toBeLessThanOrEqual(band.temp[1] + 1e-6);
      // Stefan-Boltzmann: L = 4 pi R^2 sigma T^4.
      expect(star.lum! / (4 * Math.PI * star.radius ** 2 * SIGMA * star.temp ** 4)).toBeCloseTo(1, 3);
      // Mass-luminosity relation with jitter: within a factor 1.3 of the textbook power laws.
      const expected = m < 0.43 ? 0.23 * m ** 2.3 : m < 2 ? m ** 4 : m < 55 ? 1.4 * m ** 3.5 : 32_000 * m;
      expect(star.lum! / SOLAR_LUMINOSITY / expected).toBeGreaterThan(1 / 1.3);
      expect(star.lum! / SOLAR_LUMINOSITY / expected).toBeLessThan(1.3);
      expect(star.scoopable).toBe(true);
      expect(star.rs).toBeUndefined();
    }
    expect(checked).toBeGreaterThan(600);
  });

  it('makes a sun-like star sun-like', () => {
    const suns = allStars.filter((s) => s.cls === 'G' && Math.abs(s.mass / SOLAR_MASS - 1) < 0.04);
    expect(suns.length).toBeGreaterThan(3);
    for (const s of suns) {
      expect(s.radius / 6.957e8).toBeGreaterThan(0.85);
      expect(s.radius / 6.957e8).toBeLessThan(1.2);
      expect(s.lum! / SOLAR_LUMINOSITY).toBeGreaterThan(0.7);
      expect(s.lum! / SOLAR_LUMINOSITY).toBeLessThan(1.4);
    }
  });

  it('colours stars by temperature: cool stars red, hot stars blue', () => {
    for (const star of primaries) {
      const r = (star.color >> 16) & 255;
      const b = star.color & 255;
      if (star.cls === 'M' || star.cls === 'K') expect(r).toBeGreaterThan(b);
      if (star.cls === 'A' || star.cls === 'B' || star.cls === 'O' || star.cls === 'NS') expect(b).toBeGreaterThan(r);
    }
  });

  it('makes white dwarfs about Earth-sized', () => {
    const dwarfs = allStars.filter((s) => s.cls === 'WD');
    expect(dwarfs.length).toBeGreaterThan(10);
    for (const wd of dwarfs) {
      expect(wd.mass / SOLAR_MASS).toBeGreaterThanOrEqual(0.45);
      expect(wd.mass / SOLAR_MASS).toBeLessThanOrEqual(1.25);
      expect(wd.radius / EARTH_RADIUS).toBeGreaterThan(0.8);
      expect(wd.radius / EARTH_RADIUS).toBeLessThan(1.8);
      expect(wd.lum! / (4 * Math.PI * wd.radius ** 2 * SIGMA * wd.temp ** 4)).toBeCloseTo(1, 9);
      expect(wd.lum! / SOLAR_LUMINOSITY).toBeLessThan(0.2);
      expect(wd.scoopable).toBe(false);
    }
  });

  it('makes neutron stars and black holes to the book', () => {
    const neutron = primaries.filter((s) => s.cls === 'NS');
    const holes = primaries.filter((s) => s.cls === 'BH');
    expect(neutron.length).toBeGreaterThanOrEqual(12);
    expect(holes.length).toBeGreaterThanOrEqual(12);
    for (const ns of neutron) {
      expect(ns.mass / SOLAR_MASS).toBeGreaterThanOrEqual(1.2);
      expect(ns.mass / SOLAR_MASS).toBeLessThanOrEqual(2.2);
      expect(ns.radius).toBeGreaterThan(10_000);
      expect(ns.radius).toBeLessThan(13_000);
      expect(ns.rs! / ((2 * G * ns.mass) / (C * C))).toBeCloseTo(1, 12);
      expect(ns.rs!).toBeLessThan(ns.radius);
      expect(ns.jets).toBeDefined();
      expect(ns.jets!.length).toBeGreaterThan(1e8);
      expect(ns.lum! / SOLAR_LUMINOSITY).toBeGreaterThan(0.005);
      expect(ns.lum! / SOLAR_LUMINOSITY).toBeLessThan(1);
      expect(ns.scoopable).toBe(false);
      if (ns.disk) expect(ns.disk.outer).toBeGreaterThan(ns.disk.inner);
    }
    for (const bh of holes) {
      expect(bh.mass / SOLAR_MASS).toBeGreaterThanOrEqual(5);
      expect(bh.mass / SOLAR_MASS).toBeLessThanOrEqual(30);
      expect(bh.rs! / ((2 * G * bh.mass) / (C * C))).toBeCloseTo(1, 12);
      expect(bh.radius).toBe(bh.rs);
      expect(bh.disk).toBeDefined();
      expect(bh.disk!.inner / bh.rs!).toBeCloseTo(3, 9);
      expect(bh.disk!.outer).toBeGreaterThanOrEqual(1e9);
      expect(bh.disk!.outer).toBeLessThanOrEqual(5e9);
      expect(bh.lum! / SOLAR_LUMINOSITY).toBeGreaterThanOrEqual(0.5);
      expect(bh.lum! / SOLAR_LUMINOSITY).toBeLessThanOrEqual(5);
      expect(bh.scoopable).toBe(false);
    }
  });

  it('adds a wide companion to about 12 % of systems without disturbing the planets', () => {
    const binaries = MANY.filter((s) => s.tags.includes('binary'));
    expect(binaries.length / MANY.length).toBeGreaterThan(0.07);
    expect(binaries.length / MANY.length).toBeLessThan(0.17);
    for (const sys of binaries) {
      const primary = sys.bodies[0]!;
      const companion = sys.bodies[1]!;
      expect(companion.kind).toBe('star');
      expect(companion.orbit!.parent).toBe(0);
      expect(sys.bodies.filter((b) => b.kind === 'star')).toHaveLength(2);
      expect(companion.mass).toBeLessThanOrEqual(0.5 * primary.mass * (1 + 1e-9));
      expect(companion.lum).toBeGreaterThan(0);
      // Everything that orbits the primary stays outside the companion's sphere of influence.
      let reach = arrivalDistance(sys);
      for (const p of planetsOf(sys)) reach = Math.max(reach, apo(p) + hill(p, primary.mass));
      for (const belt of sys.belts) reach = Math.max(reach, belt.outer);
      for (const site of sys.sites) if (site.orbit.parent === 0) reach = Math.max(reach, site.orbit.a);
      expect(peri(companion) - soiRadius(sys, 1)).toBeGreaterThan(reach * 1.5);
    }
    // Systems without a companion have exactly one star.
    for (const sys of MANY) if (!sys.tags.includes('binary')) expect(sys.bodies.filter((b) => b.kind === 'star')).toHaveLength(1);
  });
});

describe('planets', () => {
  const planets = MANY.flatMap((sys) => planetsOf(sys).map((p) => ({ sys, p })));

  it('chooses the planet class from the equilibrium temperature', () => {
    const seen = new Set<string>();
    for (const { sys, p } of planets) {
      seen.add(p.cls);
      const teq = equilibriumTemp(sys, p.orbit!.a);
      switch (p.cls) {
        case 'lava': expect(teq).toBeGreaterThan(650); break;
        case 'desert': expect(teq).toBeGreaterThanOrEqual(170); expect(teq).toBeLessThan(900); break;
        case 'terran':
        case 'ocean': expect(teq).toBeGreaterThanOrEqual(215); expect(teq).toBeLessThanOrEqual(310); break;
        case 'ice': expect(teq).toBeLessThan(215); break;
        default: break;
      }
      // Nothing solid survives where rock evaporates.
      expect(teq).toBeLessThan(1250);
    }
    expect([...seen].sort()).toEqual(['desert', 'gas', 'ice', 'icegiant', 'lava', 'ocean', 'rocky', 'terran']);
    // Giants live mostly beyond the frost line.
    const giants = planets.filter(({ p }) => isGiant(p));
    const cold = giants.filter(({ sys, p }) => equilibriumTemp(sys, p.orbit!.a) < 170);
    expect(cold.length / giants.length).toBeGreaterThan(0.6);
  });

  it('gives planets masses and radii that fit their class', () => {
    const RANGES: Record<string, [number, number]> = {
      rocky: [0.02, 2.5], desert: [0.08, 3], lava: [0.3, 6], terran: [0.5, 3.5], ocean: [0.8, 6], ice: [0.004, 1.5], icegiant: [10, 30],
    };
    for (const { sys, p } of planets) {
      const earths = p.mass / EARTH_MASS;
      if (p.cls === 'gas') {
        expect(p.mass / JUPITER_MASS).toBeGreaterThanOrEqual(0.3 - 1e-9);
        expect(p.mass / JUPITER_MASS).toBeLessThanOrEqual(4 + 1e-9);
        expect(p.radius / 6.9911e7).toBeGreaterThan(0.75);
        expect(p.radius / 6.9911e7).toBeLessThan(1.6);
        // A gas giant needs a star heavy enough to keep it.
        expect(p.mass / sys.bodies[0]!.mass).toBeLessThanOrEqual(0.004 + 1e-12);
      } else {
        const [lo, hi] = RANGES[p.cls]!;
        expect(earths).toBeGreaterThanOrEqual(lo * (1 - 1e-9));
        expect(earths).toBeLessThanOrEqual(hi * (1 + 1e-9));
      }
      const density = p.mass / ((4 / 3) * Math.PI * p.radius ** 3);
      expect(density).toBeGreaterThan(150);
      expect(density).toBeLessThan(12_000);
      // Rock is denser than gas.
      if (p.cls === 'rocky' || p.cls === 'terran' || p.cls === 'lava') expect(density).toBeGreaterThan(2500);
      if (isGiant(p)) expect(density).toBeLessThan(8000);
    }
  });

  it('flags living worlds, and only those, as habitable', () => {
    let habitable = 0;
    for (const { sys, p } of planets) {
      const living = p.cls === 'terran' || p.cls === 'ocean';
      expect(p.habitable === true).toBe(living);
      if (!living) continue;
      habitable++;
      // Liquid water on the surface.
      expect(p.temp).toBeGreaterThan(273);
      expect(p.temp).toBeLessThan(320);
      expect(p.atmo).toBeDefined();
      expect(['A', 'F', 'G', 'K', 'M']).toContain(sys.starClass);
    }
    expect(habitable).toBeGreaterThan(50);
    for (const sys of MANY) for (const b of sys.bodies) if (b.kind !== 'planet') expect(b.habitable).toBeUndefined();
  });

  it('puts rings on about 45 % of the giants and on nothing else', () => {
    const giants = planets.filter(({ p }) => isGiant(p));
    const ringed = giants.filter(({ p }) => p.rings);
    expect(ringed.length / giants.length).toBeGreaterThan(0.36);
    expect(ringed.length / giants.length).toBeLessThan(0.54);
    for (const sys of MANY) {
      for (const b of sys.bodies) {
        if (!b.rings) continue;
        expect(isGiant(b)).toBe(true);
        expect(b.rings.inner).toBeGreaterThan(b.radius * 1.2);
        expect(b.rings.outer).toBeGreaterThanOrEqual(b.rings.inner * 1.25);
        expect(b.rings.outer).toBeLessThanOrEqual(b.radius * 2.5);
      }
    }
  });

  it('gives atmospheres where they are plausible', () => {
    let withAtmo = 0;
    for (const { p } of planets) {
      if (p.cls === 'terran' || p.cls === 'ocean' || isGiant(p)) expect(p.atmo).toBeDefined();
      if (!p.atmo) continue;
      withAtmo++;
      expect(p.atmo.height).toBeGreaterThanOrEqual(p.radius * 0.006 - 1e-6);
      expect(p.atmo.height).toBeLessThanOrEqual(p.radius * 0.05 + 1e-6);
      expect(p.atmo.density).toBeGreaterThan(0);
      expect(p.atmo.density).toBeLessThanOrEqual(60);
      expect(p.atmo.color).toBeGreaterThanOrEqual(0);
      expect(p.atmo.color).toBeLessThanOrEqual(0xffffff);
      if (p.cls === 'terran') {
        expect(p.atmo.density).toBeGreaterThanOrEqual(0.7);
        expect(p.atmo.density).toBeLessThanOrEqual(1.5);
      }
    }
    expect(withAtmo).toBeGreaterThan(planets.length * 0.5);
    const bare = planets.filter(({ p }) => p.cls === 'rocky' && !p.atmo);
    expect(bare.length).toBeGreaterThan(planets.filter(({ p }) => p.cls === 'rocky').length * 0.7);
  });

  it('has between 0 and 9 planets depending on the star, and varied systems', () => {
    const maxByClass: Record<string, number> = {};
    for (const sys of MANY) maxByClass[sys.starClass] = Math.max(maxByClass[sys.starClass] ?? 0, planetsOf(sys).length);
    expect(maxByClass.G).toBeGreaterThanOrEqual(7);
    expect(maxByClass.BH).toBeLessThanOrEqual(3);
    expect(maxByClass.NS).toBeLessThanOrEqual(3);
    expect(MANY.some((s) => planetsOf(s).length === 0)).toBe(true);
    // Compact primaries keep their planets far out.
    for (const sys of MANY) {
      if (sys.starClass !== 'NS' && sys.starClass !== 'BH' && sys.starClass !== 'WD') continue;
      for (const p of planetsOf(sys)) expect(peri(p)).toBeGreaterThan(0.22 * AU);
    }
  });
});

describe('showcase systems', () => {
  const ALL_SERVICES = ['market', 'outfit', 'shipyard', 'missions', 'repair', 'refuel', 'cartography'];
  const runs = Array.from({ length: 60 }, (_, k) => ({ serverId: `showcase${k}`, seed: `seed-${k * 7}` }));

  it('index 0 is a secure capital with a habitable world and a full-service ring station', () => {
    for (const { serverId, seed } of runs) {
      const sys = generateSystem(serverId, seed, 0, [0, 0, 0]);
      expect(['F', 'G', 'K']).toContain(sys.starClass);
      expect(sys.security).toBe('secure');
      expect(sys.tags).toContain('capital');
      expect(sys.tags).toContain('habitable');
      const living = sys.bodies.filter((b) => b.habitable && (b.cls === 'terran' || b.cls === 'ocean'));
      expect(living.length).toBeGreaterThanOrEqual(1);

      const stations = sys.sites.filter((s) => s.kind === 'station');
      expect(stations.length).toBeGreaterThanOrEqual(2);
      expect(sys.stations).toBeGreaterThanOrEqual(2);
      const hub = sys.sites[0]!;
      expect(hub.kind).toBe('station');
      expect(hub.model).toBe('station_ring');
      expect(hub.radius).toBe(900);
      expect(hub.services).toContain('market');
      expect([...hub.services!].sort()).toEqual([...ALL_SERVICES].sort());
      // The hub orbits the living world.
      expect(sys.bodies[hub.orbit.parent]!.habitable).toBe(true);
      expect(['industrial', 'hightech']).toContain(hub.economy);
      expect(sys.faction).toBe(sectorFactions(serverId, seed)[0]);
      expect(planetsOf(sys).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('index 3 is a black hole with a disk and a Schwarzschild radius', () => {
    for (const { serverId, seed } of runs) {
      const sys = generateSystem(serverId, seed, 3, [1, 2, 3]);
      const bh = sys.bodies[0]!;
      expect(sys.starClass).toBe('BH');
      expect(bh.cls).toBe('BH');
      expect(sys.tags).toContain('blackhole');
      expect(bh.rs).toBeGreaterThan(10_000);
      expect(bh.rs! / ((2 * G * bh.mass) / (C * C))).toBeCloseTo(1, 12);
      expect(bh.disk).toBeDefined();
      expect(bh.disk!.outer).toBeGreaterThan(bh.disk!.inner);
      expect(bh.disk!.inner).toBeGreaterThan(bh.rs!);
    }
  });

  it('index 5 is a neutron star with jets', () => {
    for (const { serverId, seed } of runs) {
      const sys = generateSystem(serverId, seed, 5, [1, 2, 3]);
      const ns = sys.bodies[0]!;
      expect(sys.starClass).toBe('NS');
      expect(ns.cls).toBe('NS');
      expect(sys.tags).toContain('neutron');
      expect(ns.rs).toBeGreaterThan(3000);
      expect(ns.jets).toBeDefined();
    }
  });

  it('every black hole and neutron star has an anomaly site in calm space', () => {
    let compact = 0;
    for (const sys of [...SYSTEMS, ...MANY]) {
      const star = sys.bodies[0]!;
      const anomalies = sys.sites.filter((s) => s.kind === 'anomaly');
      if (star.cls !== 'BH' && star.cls !== 'NS') {
        expect(anomalies).toHaveLength(0);
        continue;
      }
      compact++;
      expect(anomalies.length === 1 || anomalies.length === 2).toBe(true);
      for (const site of anomalies) {
        expect(site.orbit.parent).toBe(0);
        expect(site.frameRadius).toBe(BELT_SITE_FRAME_RADIUS);
        // Paczynski-Wiita gravity at the site, and everywhere inside its zone.
        const g = (r: number): number => (G * star.mass) / (r - star.rs!) ** 2;
        expect(g(site.orbit.a)).toBeLessThan(ANOMALY_MAX_GRAVITY);
        expect(g(site.orbit.a - site.frameRadius)).toBeLessThan(2);
        expect(site.orbit.a).toBeGreaterThanOrEqual(Math.sqrt((G * star.mass) / 2));
        // Outside the accretion disk and the jets' base.
        if (star.disk) expect(site.orbit.a).toBeGreaterThan(star.disk.outer);
      }
      if (anomalies.length === 2) expect(Math.abs(anomalies[0]!.orbit.a - anomalies[1]!.orbit.a)).toBeGreaterThan(1e8);
    }
    expect(compact).toBeGreaterThanOrEqual(36);
  });
});

describe('sites', () => {
  const ALL_SERVICES = ['cartography', 'market', 'missions', 'outfit', 'refuel', 'repair', 'shipyard'];
  const sitesOf = (kind: SiteDef['kind']): { sys: SystemDef; site: SiteDef }[] =>
    [...SYSTEMS, ...MANY].flatMap((sys) => sys.sites.filter((s) => s.kind === kind).map((site) => ({ sys, site })));

  it('builds stations and outposts to specification', () => {
    const stations = sitesOf('station');
    const outposts = sitesOf('outpost');
    expect(stations.length).toBeGreaterThan(100);
    expect(outposts.length).toBeGreaterThan(100);
    for (const { site } of stations) {
      expect(site.model).toBe('station_ring');
      expect(site.radius).toBe(900);
      expect([...site.services!].sort()).toEqual(ALL_SERVICES);
      expect(['agri', 'mining', 'refinery', 'industrial', 'hightech', 'military']).toContain(site.economy);
      expect(site.frameRadius).toBe(DEFAULT_SITE_FRAME_RADIUS);
    }
    for (const { site } of outposts) {
      expect(site.model).toBe('station_outpost');
      expect(site.radius).toBe(260);
      expect([...site.services!].sort()).toEqual(['market', 'missions', 'refuel', 'repair']);
      expect(['outpost', 'mining', 'refinery']).toContain(site.economy);
      expect(site.frameRadius).toBe(DEFAULT_SITE_FRAME_RADIUS);
    }
    for (const { site } of [...stations, ...outposts]) {
      expect(ECONOMIES[site.economy!]).toBeDefined();
      expect(site.faction).toBeTruthy();
      expect(site.beltId).toBeUndefined();
      expect(site.gate).toBeUndefined();
    }
    // Every large economy occurs somewhere.
    const economies = new Set(stations.map(({ site }) => site.economy));
    expect([...economies].sort()).toEqual(['agri', 'hightech', 'industrial', 'military', 'mining', 'refinery']);
    const military = stations.filter(({ site }) => site.economy === 'military').length;
    expect(military / stations.length).toBeLessThan(0.1);
  });

  it('chooses station economies from the surroundings', () => {
    for (const { sys, site } of [...sitesOf('station'), ...sitesOf('outpost')]) {
      const host = sys.bodies[site.orbit.parent]!;
      if (site.economy === 'agri') expect(host.cls === 'terran' || host.cls === 'ocean').toBe(true);
      if (site.economy === 'refinery') expect(isGiant(host)).toBe(true);
      if (site.economy === 'mining' && host.kind === 'planet') {
        expect(['rocky', 'desert', 'lava', 'ice']).toContain(host.cls);
      }
      if (site.economy === 'mining' && host.kind === 'star') expect(sys.belts.length).toBeGreaterThan(0);
    }
  });

  it('puts stations on safe, circular orbits around their host', () => {
    let aroundPlanets = 0;
    let aroundStars = 0;
    for (const { sys, site } of [...sitesOf('station'), ...sitesOf('outpost')]) {
      const star = sys.bodies[0]!;
      const host = sys.bodies[site.orbit.parent]!;
      expect(site.orbit.e).toBe(0);
      if (host.kind === 'planet') {
        aroundPlanets++;
        const altitude = site.orbit.a - host.radius;
        if (isGiant(host)) {
          // Two to three radii out, beyond the rings.
          expect(site.orbit.a).toBeGreaterThanOrEqual(1.8 * host.radius);
          expect(site.orbit.a).toBeLessThanOrEqual(3 * host.radius * 1.26);
          if (host.rings) expect(site.orbit.a).toBeGreaterThan(host.rings.outer * 1.1);
        } else {
          // A few hundred to a few thousand kilometres up.
          expect(altitude).toBeGreaterThanOrEqual(350e3 - 1);
          expect(altitude).toBeLessThanOrEqual(6500e3 + 1);
        }
        expect(site.orbit.a).toBeLessThanOrEqual(0.45 * hill(host, star.mass) * (1 + 1e-9));
        for (const moon of moonsOf(sys, host)) expect(peri(moon) - site.orbit.a).toBeGreaterThan(site.frameRadius);
      } else {
        aroundStars++;
        expect(site.orbit.parent).toBe(0);
        // Free-flying stations keep clear of every planet's neighbourhood and of the arrival shell.
        for (const p of planetsOf(sys)) {
          const h = hill(p, star.mass);
          expect(site.orbit.a < peri(p) - h || site.orbit.a > apo(p) + h).toBe(true);
        }
        expect(site.orbit.a).toBeGreaterThan(arrivalDistance(sys) * 1.5);
        if (star.rs) expect((G * star.mass) / site.orbit.a ** 2).toBeLessThan(2);
      }
    }
    expect(aroundPlanets).toBeGreaterThan(200);
    expect(aroundStars).toBeGreaterThan(0);
    // Two stations at the same world never share an orbit.
    for (const sys of [...SYSTEMS, ...MANY]) {
      const dockable = sys.sites.filter((s) => s.kind === 'station' || s.kind === 'outpost');
      for (let i = 0; i < dockable.length; i++) {
        for (let j = 0; j < i; j++) {
          if (dockable[i]!.orbit.parent !== dockable[j]!.orbit.parent) continue;
          expect(Math.abs(dockable[i]!.orbit.a - dockable[j]!.orbit.a)).toBeGreaterThan(2 * DEFAULT_SITE_FRAME_RADIUS);
        }
      }
    }
  });

  it('leaves about 35 % of non-capital systems without a station', () => {
    const others = MANY.filter((s) => !s.tags.includes('capital'));
    const wild = others.filter((s) => s.stations === 0);
    expect(wild.length / others.length).toBeGreaterThan(0.28);
    expect(wild.length / others.length).toBeLessThan(0.42);
    // Inhabited systems range from a single outpost to a handful of stations.
    expect(Math.max(...others.map((s) => s.stations))).toBeGreaterThanOrEqual(3);
    expect(Math.max(...MANY.map((s) => s.stations))).toBeLessThanOrEqual(5);
  });

  it('grows more lawless toward the sector edge', () => {
    const edges: Record<string, number[]> = { secure: [], frontier: [], lawless: [] };
    MANY.forEach((sys, i) => {
      const k = Math.floor(i / 64);
      if (i % 64 !== 0) edges[sys.security]!.push(systemEdgeFraction(`statserver${k}`, `stat${k}`, i % 64));
    });
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    for (const list of Object.values(edges)) expect(list.length).toBeGreaterThan(50);
    expect(mean(edges.secure!)).toBeLessThan(mean(edges.frontier!));
    expect(mean(edges.frontier!)).toBeLessThan(mean(edges.lawless!));
    // The innermost systems are never lawless and the outermost never secure.
    MANY.forEach((sys, i) => {
      const edge = systemEdgeFraction(`statserver${Math.floor(i / 64)}`, `stat${Math.floor(i / 64)}`, i % 64);
      if (edge < 0.7) expect(sys.security).not.toBe('lawless');
      if (edge > 0.85) expect(sys.security).not.toBe('secure');
    });
  });

  it('puts 3 to 6 mining sites into every belt', () => {
    for (const sys of [...SYSTEMS, ...MANY]) {
      const beltSites = sys.sites.filter((s) => s.kind === 'belt');
      for (const belt of sys.belts) {
        const mine = beltSites.filter((s) => s.beltId === belt.id);
        expect(mine.length).toBeGreaterThanOrEqual(3);
        expect(mine.length).toBeLessThanOrEqual(6);
        for (const site of mine) {
          expect(site.orbit.parent).toBe(belt.parent);
          expect(site.orbit.a).toBeGreaterThan(belt.inner);
          expect(site.orbit.a).toBeLessThan(belt.outer);
          expect(site.frameRadius).toBe(BELT_SITE_FRAME_RADIUS);
          expect(site.frameRadius).toBe(60_000);
          expect(site.model).toBeUndefined();
        }
        // The sites start out spread around the belt, far from each other.
        for (let i = 0; i < mine.length; i++) {
          for (let j = 0; j < i; j++) {
            const d = v3.dist(orbitState(mine[i]!.orbit, 0).pos, orbitState(mine[j]!.orbit, 0).pos);
            expect(d).toBeGreaterThan(10 * BELT_SITE_FRAME_RADIUS);
          }
        }
      }
      for (const site of beltSites) expect(sys.belts.some((b) => b.id === site.beltId)).toBe(true);
    }
  });

  it('puts 1 or 2 mining sites into every ring system, in the ring plane', () => {
    let ringSites = 0;
    for (const sys of [...SYSTEMS, ...MANY]) {
      const sites = sys.sites.filter((s) => s.kind === 'ring');
      for (const b of sys.bodies) {
        const mine = sites.filter((s) => s.orbit.parent === b.id);
        if (!b.rings) {
          expect(mine).toHaveLength(0);
          continue;
        }
        expect(mine.length === 1 || mine.length === 2).toBe(true);
        for (const site of mine) {
          ringSites++;
          expect(site.orbit.a).toBeGreaterThan(b.rings.inner);
          expect(site.orbit.a).toBeLessThan(b.rings.outer);
          expect(site.frameRadius).toBe(RING_SITE_FRAME_RADIUS);
          expect(site.frameRadius).toBe(40_000);
          expect(site.beltId).toBeUndefined();
          // The orbit normal is the spin axis of the planet, so the site stays inside the rings.
          const s = orbitState(site.orbit, 1234.5);
          const normal = v3.normalize(v3.cross(s.pos, s.vel));
          expect(v3.dist(normal, bodySpinAxis(b))).toBeLessThan(1e-9);
        }
      }
    }
    expect(ringSites).toBeGreaterThan(300);
  });

  it('gives every system one navigation beacon near the fold arrival distance', () => {
    for (const sys of [...SYSTEMS, ...MANY]) {
      const beacons = sys.sites.filter((s) => s.kind === 'beacon');
      expect(beacons).toHaveLength(1);
      const beacon = beacons[0]!;
      const d = arrivalDistance(sys);
      expect(beacon.orbit.parent).toBe(0);
      expect(beacon.orbit.a).toBeGreaterThanOrEqual(d);
      expect(beacon.orbit.a).toBeLessThanOrEqual(d * 1.1);
      expect(beacon.model).toBe('beacon');
      expect(beacon.radius).toBe(20);
      expect(beacon.frameRadius).toBe(BEACON_FRAME_RADIUS);
      expect(beacon.frameRadius).toBe(100_000);
      expect(beacon.name).toBe(`${sys.name} Beacon`);
    }
  });

  it('never creates a gate on its own', () => {
    for (const sys of [...SYSTEMS, ...MANY]) expect(sys.sites.some((s) => s.kind === 'gate' || s.gate)).toBe(false);
  });
});

describe('bodySpinAxis', () => {
  it('is +Y rotated about +X by the tilt', () => {
    expect(bodySpinAxis({ tilt: 0 })).toEqual([0, 1, 0]);
    const axis = bodySpinAxis({ tilt: 0.4 });
    expect(v3.len(axis)).toBeCloseTo(1, 12);
    expect(axis[0]).toBe(0);
    expect(axis[1]).toBeCloseTo(Math.cos(0.4), 12);
    expect(axis[2]).toBeCloseTo(Math.sin(0.4), 12);
  });
});
