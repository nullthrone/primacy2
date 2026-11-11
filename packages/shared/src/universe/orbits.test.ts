import { describe, expect, it } from 'vitest';
import { AU, EARTH_MASS, G, SITE_ID_BASE, SOLAR_MASS, YEAR } from '../constants.ts';
import { v3, type Vec3 } from '../math.ts';
import { Rng } from '../prng.ts';
import { generateSector } from './generate.ts';
import {
  allBodyStates, anchorName, anchorState, bodyState, circularOrbit, findSite, isValidAnchor, orbitalPeriod, orbitState,
  pickCruiseAnchor, pickNormalAnchor, soiRadius, solveKepler,
} from './orbits.ts';
import type { BodyDef, OrbitDef, SystemDef } from './types.ts';

const TWO_PI = Math.PI * 2;

/** Wraps an angle into (-pi, pi]. */
const wrap = (x: number): number => {
  const m = ((x % TWO_PI) + TWO_PI) % TWO_PI;
  return m > Math.PI ? m - TWO_PI : m;
};

/** A random bound orbit around a parent of the returned mass. */
function randomOrbit(rng: Rng, maxE = 0.95): { orbit: OrbitDef; mass: number } {
  const mass = rng.logRange(0.1, 30) * SOLAR_MASS;
  const a = rng.logRange(0.02, 40) * AU;
  const orbit: OrbitDef = {
    parent: 0,
    a,
    e: rng.range(0, maxE),
    inc: rng.range(0, Math.PI),
    node: rng.range(0, TWO_PI),
    argp: rng.range(0, TWO_PI),
    m0: rng.range(0, TWO_PI),
    period: orbitalPeriod(a, mass),
  };
  return { orbit, mass };
}

const body = (id: number, kind: BodyDef['kind'], cls: BodyDef['cls'], mass: number, radius: number, orbit: OrbitDef | null): BodyDef => ({
  id, name: `Body ${id}`, kind, cls, mass, radius, orbit, rotPeriod: 86_400, tilt: 0, seed: id, color: 0xffffff, temp: 300,
});

const system = (bodies: BodyDef[]): SystemDef => ({
  id: 'x:0', name: 'X', pos: [0, 0, 0], starClass: 'G', security: 'secure', stations: 0, tags: [], seed: 1, bodies, belts: [], sites: [],
});

const generated: SystemDef[] = generateSector({ serverId: 'orbitstestserver', seed: 'orbits', center: [0, 0, 0], radius: 18, count: 16 });

describe('solveKepler', () => {
  it('satisfies M = E - e sin E for random M and e up to 0.95', () => {
    const rng = new Rng('kepler');
    for (let i = 0; i < 5000; i++) {
      const m = rng.range(-60, 60);
      const e = rng.range(0, 0.95);
      const E = solveKepler(m, e);
      expect(Number.isFinite(E)).toBe(true);
      expect(Math.abs(wrap(E - e * Math.sin(E) - m))).toBeLessThan(1e-10);
    }
  });

  it('handles the awkward corners', () => {
    for (const e of [0, 1e-12, 0.3, 0.8, 0.95]) {
      for (const m of [0, 1e-9, -1e-9, Math.PI, -Math.PI, TWO_PI, 0.5 * Math.PI, 1e-3, 100 * TWO_PI + 0.25]) {
        const E = solveKepler(m, e);
        expect(Math.abs(wrap(E - e * Math.sin(E) - m)), `M=${m} e=${e}`).toBeLessThan(1e-10);
      }
    }
    expect(solveKepler(0, 0.5)).toBeCloseTo(0, 12);
    expect(Math.abs(solveKepler(Math.PI, 0.5))).toBeCloseTo(Math.PI, 12);
  });

  it('returns the mean anomaly itself for a circle', () => {
    expect(solveKepler(1.25, 0)).toBeCloseTo(1.25, 14);
    expect(solveKepler(1.25 + TWO_PI, 0)).toBeCloseTo(1.25, 12);
  });
});

describe('orbitalPeriod', () => {
  it('gives one year for 1 AU around one solar mass', () => {
    expect(orbitalPeriod(AU, SOLAR_MASS) / YEAR).toBeCloseTo(1, 3);
  });

  it('obeys the third law: P^2 scales with a^3 / M', () => {
    const p1 = orbitalPeriod(AU, SOLAR_MASS);
    expect(orbitalPeriod(4 * AU, SOLAR_MASS) / p1).toBeCloseTo(8, 10);
    expect(orbitalPeriod(AU, 4 * SOLAR_MASS) / p1).toBeCloseTo(0.5, 10);
  });
});

describe('orbitState', () => {
  it('returns to its start after one period', () => {
    const rng = new Rng('period');
    for (let i = 0; i < 300; i++) {
      const { orbit } = randomOrbit(rng);
      const t0 = rng.range(-5, 5) * orbit.period;
      const s0 = orbitState(orbit, t0);
      const s1 = orbitState(orbit, t0 + orbit.period);
      // Near periapsis of a very eccentric orbit the body moves fast, so compare against the local scale.
      const r = v3.len(s0.pos);
      expect(v3.dist(s0.pos, s1.pos) / r).toBeLessThan(1e-6);
      expect(v3.dist(s0.vel, s1.vel) / v3.len(s0.vel)).toBeLessThan(1e-6);
      // Half a period later it is on the other side of the focus.
      expect(v3.dist(s0.pos, orbitState(orbit, t0 + orbit.period / 2).pos)).toBeGreaterThan(orbit.a * (1 - orbit.e));
    }
  });

  it('matches vis-viva: v^2 = GM (2/r - 1/a)', () => {
    const rng = new Rng('visviva');
    for (let i = 0; i < 500; i++) {
      const { orbit, mass } = randomOrbit(rng);
      const s = orbitState(orbit, rng.range(0, 3) * orbit.period);
      const r = v3.len(s.pos);
      const expected = G * mass * (2 / r - 1 / orbit.a);
      expect(v3.lenSq(s.vel) / expected).toBeCloseTo(1, 9);
    }
  });

  it('keeps a constant radius and speed on a circular orbit', () => {
    const rng = new Rng('circle');
    for (let i = 0; i < 100; i++) {
      const mass = rng.logRange(0.1, 30) * SOLAR_MASS;
      const a = rng.logRange(0.01, 50) * AU;
      const orbit = circularOrbit(0, mass, a, rng.range(0, TWO_PI), rng.range(0, 1), rng.range(0, TWO_PI));
      expect(orbit.period).toBe(orbitalPeriod(a, mass));
      expect(orbit.e).toBe(0);
      const speed = Math.sqrt((G * mass) / a);
      for (let k = 0; k < 20; k++) {
        const s = orbitState(orbit, rng.range(0, 2) * orbit.period);
        expect(v3.len(s.pos) / a).toBeCloseTo(1, 12);
        expect(v3.len(s.vel) / speed).toBeCloseTo(1, 12);
        // Velocity is perpendicular to the radius on a circle.
        expect(Math.abs(v3.dot(s.pos, s.vel)) / (a * speed)).toBeLessThan(1e-12);
      }
    }
  });

  it('conserves angular momentum along an eccentric orbit', () => {
    const rng = new Rng('momentum');
    for (let i = 0; i < 200; i++) {
      const { orbit, mass } = randomOrbit(rng, 0.9);
      const start = orbitState(orbit, 0);
      const h0 = v3.cross(start.pos, start.vel);
      const magnitude = Math.sqrt(G * mass * orbit.a * (1 - orbit.e * orbit.e));
      expect(v3.len(h0) / magnitude).toBeCloseTo(1, 9);
      for (let k = 1; k <= 12; k++) {
        const s = orbitState(orbit, (k / 12.5) * orbit.period);
        expect(v3.dist(v3.cross(s.pos, s.vel), h0) / magnitude).toBeLessThan(1e-9);
      }
      // The orbit normal follows from inclination and node; +Y is north.
      const normal: Vec3 = [
        Math.sin(orbit.inc) * Math.sin(orbit.node),
        Math.cos(orbit.inc),
        Math.sin(orbit.inc) * Math.cos(orbit.node),
      ];
      expect(v3.dist(v3.scale(h0, 1 / magnitude), normal)).toBeLessThan(1e-9);
    }
  });

  it('reaches periapsis at M = 0 and apoapsis half a period later', () => {
    const rng = new Rng('apsides');
    for (let i = 0; i < 100; i++) {
      const { orbit } = randomOrbit(rng, 0.9);
      const tPeri = (-orbit.m0 / TWO_PI) * orbit.period;
      expect(v3.len(orbitState(orbit, tPeri).pos) / (orbit.a * (1 - orbit.e))).toBeCloseTo(1, 9);
      expect(v3.len(orbitState(orbit, tPeri + orbit.period / 2).pos) / (orbit.a * (1 + orbit.e))).toBeCloseTo(1, 9);
      for (let k = 0; k < 10; k++) {
        const r = v3.len(orbitState(orbit, rng.range(0, 1) * orbit.period).pos);
        expect(r).toBeGreaterThanOrEqual(orbit.a * (1 - orbit.e) * (1 - 1e-9));
        expect(r).toBeLessThanOrEqual(orbit.a * (1 + orbit.e) * (1 + 1e-9));
      }
    }
  });

  it('has a velocity that is the time derivative of the position', () => {
    const rng = new Rng('derivative');
    for (let i = 0; i < 200; i++) {
      const { orbit } = randomOrbit(rng, 0.8);
      const t = rng.range(0, 1) * orbit.period;
      const dt = orbit.period * 1e-6;
      const numeric = v3.scale(v3.sub(orbitState(orbit, t + dt).pos, orbitState(orbit, t - dt).pos), 1 / (2 * dt));
      const s = orbitState(orbit, t);
      expect(v3.dist(numeric, s.vel) / v3.len(s.vel)).toBeLessThan(1e-5);
    }
  });

  it('runs counter-clockwise seen from +Y in the system plane', () => {
    const orbit = circularOrbit(0, SOLAR_MASS, AU, 0);
    const start = orbitState(orbit, 0);
    expect(v3.dist(start.pos, [AU, 0, 0]) / AU).toBeLessThan(1e-12);
    // From +X the body heads toward -Z, which is a positive rotation about +Y.
    expect(start.vel[2]).toBeLessThan(0);
    expect(Math.abs(start.vel[0]) / v3.len(start.vel)).toBeLessThan(1e-12);
    const quarter = orbitState(orbit, orbit.period / 4);
    expect(v3.dist(quarter.pos, [0, 0, -AU]) / AU).toBeLessThan(1e-9);
  });
});

describe('body and anchor states', () => {
  it('allBodyStates equals bodyState for every body', () => {
    let checked = 0;
    for (const sys of generated) {
      for (const t of [0, 12_345.678, 2.7e7, 9.1e9]) {
        const all = allBodyStates(sys, t);
        expect(all.length).toBe(sys.bodies.length);
        for (const b of sys.bodies) {
          const single = bodyState(sys, b.id, t);
          expect(all[b.id]!.pos).toEqual(single.pos);
          expect(all[b.id]!.vel).toEqual(single.vel);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('keeps the primary at rest at the origin and chains moons onto their planets', () => {
    let moons = 0;
    for (const sys of generated) {
      expect(bodyState(sys, 0, 1e6)).toEqual({ pos: [0, 0, 0], vel: [0, 0, 0] });
      for (const b of sys.bodies) {
        if (b.kind !== 'moon') continue;
        moons++;
        const t = 5.5e6;
        const parent = bodyState(sys, b.orbit!.parent, t);
        const rel = orbitState(b.orbit!, t);
        const abs = bodyState(sys, b.id, t);
        expect(v3.dist(abs.pos, v3.add(parent.pos, rel.pos))).toBeLessThan(1e-3);
        expect(v3.dist(abs.vel, v3.add(parent.vel, rel.vel))).toBeLessThan(1e-9);
      }
    }
    expect(moons).toBeGreaterThan(0);
  });

  it('falls back to the slow path when a parent is listed after its child', () => {
    const star = body(0, 'star', 'G', SOLAR_MASS, 7e8, null);
    const moon = body(1, 'moon', 'rocky', 7e22, 1.7e6, circularOrbit(2, EARTH_MASS, 3.8e8, 2));
    const planet = body(2, 'planet', 'rocky', EARTH_MASS, 6.4e6, circularOrbit(0, SOLAR_MASS, AU, 1));
    const sys = system([star, moon, planet]);
    const all = allBodyStates(sys, 4e6);
    for (const b of sys.bodies) expect(v3.dist(all[b.id]!.pos, bodyState(sys, b.id, 4e6).pos)).toBeLessThan(1e-3);
    expect(v3.dist(all[1]!.pos, all[2]!.pos) / 3.8e8).toBeCloseTo(1, 9);
  });

  it('anchorState of a site is its parent state plus its own orbit', () => {
    let sites = 0;
    for (const sys of generated) {
      for (const site of sys.sites) {
        sites++;
        const t = 1.234e7;
        const parent = bodyState(sys, site.orbit.parent, t);
        const rel = orbitState(site.orbit, t);
        const abs = anchorState(sys, site.id, t);
        expect(abs.pos).toEqual(v3.add(parent.pos, rel.pos));
        expect(abs.vel).toEqual(v3.add(parent.vel, rel.vel));
        expect(findSite(sys, site.id)).toBe(site);
        expect(isValidAnchor(sys, site.id)).toBe(true);
        expect(anchorName(sys, site.id)).toBe(site.name);
      }
      expect(anchorState(sys, 0, 5)).toEqual(bodyState(sys, 0, 5));
      expect(isValidAnchor(sys, sys.bodies.length - 1)).toBe(true);
      expect(isValidAnchor(sys, sys.bodies.length)).toBe(false);
      expect(isValidAnchor(sys, SITE_ID_BASE + sys.sites.length)).toBe(false);
      expect(isValidAnchor(sys, -1)).toBe(false);
      expect(isValidAnchor(sys, 0.5)).toBe(false);
      expect(findSite(sys, 0)).toBeUndefined();
      expect(() => anchorState(sys, SITE_ID_BASE + sys.sites.length, 0)).toThrow();
      expect(() => bodyState(sys, sys.bodies.length, 0)).toThrow();
      expect(anchorName(sys, 0)).toBe(sys.bodies[0]!.name);
      expect(anchorName(sys, 99_999)).toBe('Unknown');
    }
    expect(sites).toBeGreaterThan(16);
  });
});

describe('spheres of influence', () => {
  it('is infinite for the primary and a (m/M)^(2/5) for an Earth-like planet', () => {
    const star = body(0, 'star', 'G', SOLAR_MASS, 7e8, null);
    const planet = body(1, 'planet', 'terran', EARTH_MASS, 6.371e6, circularOrbit(0, SOLAR_MASS, AU, 0));
    const sys = system([star, planet]);
    expect(soiRadius(sys, 0)).toBe(Infinity);
    // The textbook value for Earth is about 925 000 km.
    expect(soiRadius(sys, 1) / 9.25e8).toBeCloseTo(1, 2);
    expect(soiRadius(sys, 7)).toBe(Infinity);

    const planetPos = bodyState(sys, 1, 0).pos;
    expect(pickCruiseAnchor(sys, v3.add(planetPos, [1e8, 0, 0]), 0)).toBe(1);
    expect(pickCruiseAnchor(sys, v3.add(planetPos, [2e9, 0, 0]), 0)).toBe(0);
    expect(pickCruiseAnchor(sys, [0, 5e10, 0], 0)).toBe(0);
  });

  it('is never smaller than three body radii', () => {
    const star = body(0, 'star', 'G', SOLAR_MASS, 7e8, null);
    const pebble = body(1, 'planet', 'rocky', 1e10, 5e5, circularOrbit(0, SOLAR_MASS, AU, 0));
    expect(soiRadius(system([star, pebble]), 1)).toBe(1.5e6);
  });

  it('picks the innermost sphere of influence and prefers a site frame in normal space', () => {
    for (const sys of generated) {
      const t = 3.3e6;
      for (const b of sys.bodies) {
        if (b.kind !== 'moon') continue;
        // Just above a moon's surface the moon wins over its planet and the star.
        const pos = v3.add(bodyState(sys, b.id, t).pos, [b.radius * 1.5, 0, 0]);
        expect(pickCruiseAnchor(sys, pos, t)).toBe(b.id);
      }
      for (const site of sys.sites) {
        const pos = v3.add(anchorState(sys, site.id, t).pos, [0, site.frameRadius * 0.01, 0]);
        expect(pickNormalAnchor(sys, pos, t)).toBe(site.id);
      }
      expect(pickNormalAnchor(sys, [0, 9e15, 0], t)).toBe(0);
    }
  });
});
