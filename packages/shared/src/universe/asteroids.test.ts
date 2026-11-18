import { describe, expect, it } from 'vitest';
import { COMMODITIES } from '../catalog.ts';
import { v3 } from '../math.ts';
import { ASTEROID_CLEAR_RADIUS, generateAsteroids } from './asteroids.ts';
import { bodySpinAxis, generateSector } from './generate.ts';
import type { AsteroidDef, BeltKind, OreId, SiteDef, SystemDef } from './types.ts';

const SYSTEMS: SystemDef[] = [
  ...generateSector({ serverId: 'asteroidserver00', seed: 'rocks', center: [0, 0, 0], radius: 18, count: 32 }),
  ...generateSector({ serverId: 'asteroidserver01', seed: 'more rocks', center: [0, 0, 0], radius: 18, count: 32 }),
];

interface Field { sys: SystemDef; site: SiteDef; rocks: AsteroidDef[] }

const FIELDS: Field[] = SYSTEMS.flatMap((sys) =>
  sys.sites
    .filter((site) => site.kind === 'belt' || site.kind === 'ring' || site.kind === 'anomaly')
    .map((site) => ({ sys, site, rocks: generateAsteroids(sys, site) })),
);
const fieldsOf = (kind: SiteDef['kind']): Field[] => FIELDS.filter((f) => f.site.kind === kind);

const ORES: Record<BeltKind, OreId[]> = {
  rock: ['silicates', 'iron_ore', 'copper_ore', 'titanium_ore'],
  metal: ['iron_ore', 'titanium_ore', 'copper_ore', 'platinum_ore'],
  ice: ['ice', 'helium3', 'silicates'],
};

/** A copy of a system whose first belt has the given kind and richness, with one of its belt sites. */
function beltField(kind: BeltKind, richness: number): Field {
  const source = SYSTEMS.find((s) => s.belts.length > 0)!;
  const sys: SystemDef = JSON.parse(JSON.stringify(source));
  sys.belts[0]!.kind = kind;
  sys.belts[0]!.richness = richness;
  const site = sys.sites.find((s) => s.kind === 'belt' && s.beltId === sys.belts[0]!.id)!;
  return { sys, site, rocks: generateAsteroids(sys, site) };
}

describe('generateAsteroids', () => {
  it('covers belt, ring and anomaly sites in the sample', () => {
    expect(fieldsOf('belt').length).toBeGreaterThan(20);
    expect(fieldsOf('ring').length).toBeGreaterThan(10);
    expect(fieldsOf('anomaly').length).toBeGreaterThanOrEqual(4);
  });

  it('is deterministic', () => {
    for (const { sys, site, rocks } of FIELDS) {
      expect(generateAsteroids(sys, site)).toEqual(rocks);
    }
    // A copy of the definitions, as a client receives them over the wire, gives the same field.
    for (const { sys, site, rocks } of FIELDS.slice(0, 12)) {
      const wire: SystemDef = JSON.parse(JSON.stringify(sys));
      expect(generateAsteroids(wire, wire.sites.find((s) => s.id === site.id)!)).toEqual(rocks);
    }
  });

  it('depends on the site seed only, not on the site id or orbit', () => {
    const { sys, site, rocks } = fieldsOf('belt')[0]!;
    expect(generateAsteroids(sys, { ...site, id: 4242, orbit: { ...site.orbit, m0: 1, a: site.orbit.a * 1.01 } })).toEqual(rocks);
    const other = generateAsteroids(sys, { ...site, seed: site.seed + 1 });
    expect(other.map((r) => r.pos)).not.toEqual(rocks.map((r) => r.pos));
  });

  it('returns nothing for sites that are not mining sites', () => {
    let checked = 0;
    for (const sys of SYSTEMS) {
      for (const site of sys.sites) {
        if (site.kind === 'belt' || site.kind === 'ring' || site.kind === 'anomaly') continue;
        checked++;
        expect(generateAsteroids(sys, site)).toEqual([]);
      }
    }
    expect(checked).toBeGreaterThan(64);
    const beacon = SYSTEMS[0]!.sites.find((s) => s.kind === 'beacon')!;
    expect(generateAsteroids(SYSTEMS[0]!, { ...beacon, kind: 'gate' })).toEqual([]);
  });

  it('numbers asteroids by their array index', () => {
    for (const { rocks } of FIELDS) rocks.forEach((rock, i) => expect(rock.idx).toBe(i));
  });

  it('keeps counts in range for every kind of site', () => {
    for (const { sys, site, rocks } of fieldsOf('belt')) {
      const belt = sys.belts.find((b) => b.id === site.beltId)!;
      expect(rocks.length).toBeGreaterThanOrEqual(180);
      expect(rocks.length).toBeLessThanOrEqual(420);
      // Scaled by the richness of the belt.
      expect(rocks.length).toBeGreaterThanOrEqual(180 + Math.floor(240 * belt.richness * 0.8));
      expect(rocks.length).toBeLessThanOrEqual(180 + Math.ceil(240 * belt.richness));
    }
    for (const { rocks } of fieldsOf('ring')) {
      expect(rocks.length).toBeGreaterThanOrEqual(300);
      expect(rocks.length).toBeLessThanOrEqual(520);
    }
    for (const { rocks } of fieldsOf('anomaly')) {
      expect(rocks.length).toBeGreaterThanOrEqual(40);
      expect(rocks.length).toBeLessThanOrEqual(80);
    }
    expect(beltField('rock', 0).rocks).toHaveLength(180);
    expect(beltField('rock', 1).rocks.length).toBeGreaterThanOrEqual(372);
    expect(beltField('rock', 1).rocks.length).toBeLessThanOrEqual(420);
    expect(beltField('rock', 0.2).rocks.length).toBeLessThan(beltField('rock', 0.9).rocks.length);
  });

  it('never lets two asteroids overlap', () => {
    let pairs = 0;
    for (const { site, rocks } of FIELDS) {
      for (let i = 0; i < rocks.length; i++) {
        const a = rocks[i]!;
        for (let j = 0; j < i; j++) {
          const b = rocks[j]!;
          pairs++;
          if (v3.dist(a.pos, b.pos) <= a.radius + b.radius) {
            throw new Error(`asteroids ${j} and ${i} of ${site.name} overlap`);
          }
        }
      }
    }
    expect(pairs).toBeGreaterThan(1_000_000);
  });

  it('keeps a sphere of 800 m around the anchor empty and stays inside the site frame', () => {
    expect(ASTEROID_CLEAR_RADIUS).toBe(800);
    for (const { site, rocks } of FIELDS) {
      const extent = site.kind === 'belt' ? 0.55 : site.kind === 'ring' ? 0.5 : 0.3;
      for (const rock of rocks) {
        const d = v3.len(rock.pos);
        expect(d - rock.radius).toBeGreaterThanOrEqual(800 - 1e-6);
        // "About" the nominal extent: a crowded field may spill a little further out.
        expect(d).toBeLessThanOrEqual(extent * site.frameRadius * 1.25);
        expect(d + rock.radius).toBeLessThan(site.frameRadius);
      }
      // The field really reaches out to most of its extent and is densest near the anchor.
      const distances = rocks.map((r) => v3.len(r.pos)).sort((x, y) => x - y);
      expect(distances[distances.length - 1]!).toBeGreaterThan(0.5 * extent * site.frameRadius);
      expect(distances[Math.floor(distances.length / 2)]!).toBeLessThan(0.5 * extent * site.frameRadius);
    }
  });

  it('flattens belt fields vertically and ring fields into the ring plane', () => {
    for (const { rocks } of fieldsOf('belt')) {
      const vertical = Math.max(...rocks.map((r) => Math.abs(r.pos[1])));
      const horizontal = Math.max(...rocks.map((r) => Math.hypot(r.pos[0], r.pos[2])));
      expect(vertical).toBeLessThan(0.4 * horizontal);
    }
    for (const { sys, site, rocks } of fieldsOf('ring')) {
      const axis = bodySpinAxis(sys.bodies[site.orbit.parent]!);
      const offPlane = Math.max(...rocks.map((r) => Math.abs(v3.dot(r.pos, axis))));
      const extent = Math.max(...rocks.map((r) => v3.len(r.pos)));
      expect(offPlane).toBeLessThan(0.08 * extent);
    }
  });

  it('sizes asteroids on a power law: many small, few large', () => {
    for (const { site, rocks } of FIELDS) {
      const [lo, hi] = site.kind === 'belt' ? [12, 450] : site.kind === 'ring' ? [6, 140] : [8, 60];
      const radii = rocks.map((r) => r.radius).sort((x, y) => x - y);
      for (const r of radii) {
        // A rock may be shrunk to fit a crowded field, but never below half the nominal minimum.
        expect(r).toBeGreaterThanOrEqual(lo * 0.5);
        expect(r).toBeLessThanOrEqual(hi);
      }
      const median = radii[Math.floor(radii.length / 2)]!;
      expect(median).toBeLessThan(lo * 3.2);
      expect(radii[radii.length - 1]!).toBeGreaterThan(median * 1.5);
    }
    const all = fieldsOf('belt').flatMap((f) => f.rocks.map((r) => r.radius));
    const share = (limit: number): number => all.filter((r) => r > limit).length / all.length;
    expect(share(12 - 1e-9)).toBe(1);
    expect(share(50)).toBeGreaterThan(0.12);
    expect(share(50)).toBeLessThan(0.32);
    expect(share(200)).toBeGreaterThan(0.01);
    expect(share(200)).toBeLessThan(0.08);
    // Ring rocks are smaller than belt rocks.
    const ringAll = fieldsOf('ring').flatMap((f) => f.rocks.map((r) => r.radius));
    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean(ringAll)).toBeLessThan(mean(all) * 0.6);
  });

  it('makes ring fields denser than belt fields', () => {
    const density = (f: Field): number => {
      const near = f.rocks.filter((r) => v3.len(r.pos) < 6000).length;
      return near;
    };
    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean(fieldsOf('ring').map(density))).toBeGreaterThan(mean(fieldsOf('belt').map(density)));
  });

  it('weights ore by the kind of belt', () => {
    for (const kind of ['rock', 'metal', 'ice'] as const) {
      const { rocks } = beltField(kind, 1);
      const count: Record<string, number> = {};
      for (const rock of rocks) count[rock.ore] = (count[rock.ore] ?? 0) + 1;
      expect(Object.keys(count).sort()).toEqual([...ORES[kind]].sort());
      // The first ore of each table is the most common one.
      const dominant = Object.entries(count).sort((x, y) => y[1] - x[1])[0]![0];
      expect(dominant).toBe(ORES[kind][0]);
    }
    for (const { sys, site, rocks } of fieldsOf('belt')) {
      const belt = sys.belts.find((b) => b.id === site.beltId)!;
      for (const rock of rocks) expect(ORES[belt.kind]).toContain(rock.ore);
    }
    const metal = beltField('metal', 1).rocks;
    const platinum = metal.filter((r) => r.ore === 'platinum_ore').length / metal.length;
    expect(platinum).toBeGreaterThan(0);
    expect(platinum).toBeLessThan(0.2);
  });

  it('fills rings with ice and rock', () => {
    const count: Record<string, number> = {};
    for (const { rocks } of fieldsOf('ring')) {
      for (const rock of rocks) {
        expect(['ice', 'silicates', 'iron_ore', 'helium3']).toContain(rock.ore);
        count[rock.ore] = (count[rock.ore] ?? 0) + 1;
      }
    }
    expect(count.ice!).toBeGreaterThan(count.silicates!);
    expect(count.silicates!).toBeGreaterThan(count.iron_ore!);
  });

  it('fills anomaly fields mostly with exotic matter in small amounts, plus some platinum', () => {
    let exotic = 0;
    let platinum = 0;
    for (const { rocks } of fieldsOf('anomaly')) {
      expect(rocks.some((r) => r.ore === 'exotic_matter')).toBe(true);
      for (const rock of rocks) {
        expect(['exotic_matter', 'platinum_ore']).toContain(rock.ore);
        expect(rock.amount).toBeLessThanOrEqual(12);
        expect(rock.radius).toBeLessThanOrEqual(60);
        if (rock.ore === 'exotic_matter') exotic++;
        else platinum++;
      }
    }
    expect(exotic).toBeGreaterThan(platinum * 1.5);
    expect(platinum).toBeGreaterThan(0);
    // Exotic matter occurs nowhere else.
    for (const f of [...fieldsOf('belt'), ...fieldsOf('ring')]) expect(f.rocks.some((r) => r.ore === 'exotic_matter')).toBe(false);
  });

  it('holds ore in proportion to radius squared and belt richness', () => {
    for (const { rocks } of FIELDS) {
      for (const rock of rocks) {
        expect(Number.isInteger(rock.amount)).toBe(true);
        expect(rock.amount).toBeGreaterThanOrEqual(1);
        // Every ore is a commodity the stations trade.
        expect(COMMODITIES[rock.ore]).toBeDefined();
      }
    }
    const poor = beltField('rock', 0.25).rocks;
    const rich = beltField('rock', 1).rocks;
    const yieldOf = (rocks: AsteroidDef[]): number => {
      const big = rocks.filter((r) => r.ore === 'silicates' && r.radius > 40);
      return big.reduce((s, r) => s + r.amount / (r.radius * r.radius), 0) / big.length;
    };
    // Four times the richness gives four times the ore per unit of cross-section.
    expect(yieldOf(rich) / yieldOf(poor)).toBeGreaterThan(3);
    expect(yieldOf(rich) / yieldOf(poor)).toBeLessThan(5.2);
    // Within one field the amount follows radius squared (within the grade jitter of +-30 %).
    for (const rock of rich.filter((r) => r.ore === 'silicates' && r.radius > 40)) {
      const k = rock.amount / (rock.radius * rock.radius);
      expect(k).toBeGreaterThan(0.03 * 0.69);
      expect(k).toBeLessThan(0.03 * 1.31);
    }
  });

  it('gives every asteroid a valid shape, spin axis and rotation', () => {
    const variants = new Set<number>();
    for (const { rocks } of FIELDS) {
      for (const rock of rocks) {
        expect(v3.isFinite(rock.pos)).toBe(true);
        expect([0, 1, 2, 3]).toContain(rock.variant);
        variants.add(rock.variant);
        expect(v3.len(rock.axis)).toBeCloseTo(1, 12);
        expect(rock.spin).toBeGreaterThan(0);
        expect(rock.spin).toBeLessThan(0.1);
        expect(rock.phase).toBeGreaterThanOrEqual(0);
        expect(rock.phase).toBeLessThan(2 * Math.PI);
      }
    }
    expect(variants.size).toBe(4);
  });

  it('falls back to a plain rock field when the belt of a site is missing', () => {
    const { sys, site } = fieldsOf('belt')[0]!;
    const rocks = generateAsteroids({ ...sys, belts: [] }, site);
    expect(rocks.length).toBeGreaterThanOrEqual(180);
    expect(rocks.length).toBeLessThanOrEqual(420);
    for (const rock of rocks) expect(ORES.rock).toContain(rock.ore);
  });
});
