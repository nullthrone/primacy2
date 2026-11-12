import { describe, expect, it } from 'vitest';
import { DEFAULT_SITE_FRAME_RADIUS, SITE_ID_BASE, YEAR } from '../constants.ts';
import { v3, type Vec3 } from '../math.ts';
import { generateSector, generateSystem, summarize, upsertGateSite } from './generate.ts';
import { anchorState, findSite, isValidAnchor, orbitalPeriod, orbitState, soiRadius } from './orbits.ts';
import type { GateInfo, SystemDef } from './types.ts';

const PEER = 'peerpeerpeerpeer';
const gate = (linkId: string, over: Partial<GateInfo> = {}): GateInfo => ({
  linkId, peer: PEER, remoteSystem: `${PEER}:4`, state: 'planned', progress: 0, remoteProgress: 0, ...over,
});

const SERVER = 'gateservergatese';
const sector = (): SystemDef[] => generateSector({ serverId: SERVER, seed: 'gates', center: [0, 0, 0], radius: 18, count: 24 });

/** Largest distance from the primary reached by anything that orbits it directly. */
function extentOf(sys: SystemDef): number {
  const star = sys.bodies[0]!;
  let extent = 0;
  for (const b of sys.bodies) {
    if (b.kind !== 'planet') continue;
    const hill = b.orbit!.a * (1 - b.orbit!.e) * Math.cbrt(b.mass / (3 * star.mass));
    extent = Math.max(extent, b.orbit!.a * (1 + b.orbit!.e) + hill);
  }
  for (const belt of sys.belts) extent = Math.max(extent, belt.outer);
  for (const site of sys.sites) if (site.kind !== 'gate' && site.orbit.parent === 0) extent = Math.max(extent, site.orbit.a);
  return extent;
}

describe('upsertGateSite', () => {
  it('adds a gate site with the id SITE_ID_BASE + index', () => {
    for (const sys of sector()) {
      const before = sys.sites.length;
      const info = gate('link-1');
      const site = upsertGateSite(sys, info, [1, 0, 0]);
      expect(sys.sites).toHaveLength(before + 1);
      expect(sys.sites[before]).toBe(site);
      expect(site.id).toBe(SITE_ID_BASE + before);
      expect(site.kind).toBe('gate');
      expect(site.model).toBe('gate');
      expect(site.radius).toBe(600);
      expect(site.frameRadius).toBe(DEFAULT_SITE_FRAME_RADIUS);
      expect(site.name).toBe(`Gate to ${PEER}:4`);
      expect(site.gate).toEqual(info);
      expect(site.gate).not.toBe(info);
      expect(site.orbit.parent).toBe(0);
      expect(site.orbit.e).toBe(0);
      expect(site.orbit.period).toBe(orbitalPeriod(site.orbit.a, sys.bodies[0]!.mass));
      expect(findSite(sys, site.id)).toBe(site);
      expect(isValidAnchor(sys, site.id)).toBe(true);
      expect(v3.isFinite(anchorState(sys, site.id, 1e7).pos)).toBe(true);
      expect(sys.tags).toContain('gate');
      expect(summarize(sys).tags).toContain('gate');
    }
  });

  it('reuses the site when the link id is already present', () => {
    for (const sys of sector().slice(0, 8)) {
      const first = upsertGateSite(sys, gate('link-1'), [0, 0, 1]);
      const count = sys.sites.length;
      const snapshot = { ...first.orbit };
      // The server renames gates once it knows the far end's name.
      first.name = 'Gate to Somewhere';
      const again = upsertGateSite(sys, gate('link-1', { state: 'active', progress: 1, remoteProgress: 0.5 }), [-1, 0, 0]);
      expect(again).toBe(first);
      expect(again.id).toBe(first.id);
      expect(sys.sites).toHaveLength(count);
      expect(again.gate).toEqual(gate('link-1', { state: 'active', progress: 1, remoteProgress: 0.5 }));
      expect(again.name).toBe('Gate to Somewhere');
      expect(again.orbit).toEqual(snapshot);
      expect(sys.tags.filter((t) => t === 'gate')).toHaveLength(1);
      sys.sites.forEach((s, i) => expect(s.id).toBe(SITE_ID_BASE + i));
    }
  });

  it('gives different links different sites that do not share a spot', () => {
    for (const sys of sector().slice(0, 8)) {
      const before = sys.sites.length;
      const a = upsertGateSite(sys, gate('link-a'), [1, 0, 0]);
      const b = upsertGateSite(sys, gate('link-b'), [1, 0, 0]);
      const c = upsertGateSite(sys, gate('link-c', { remoteSystem: `${PEER}:9` }), [0, 0, -1]);
      expect(sys.sites).toHaveLength(before + 3);
      expect([a.id, b.id, c.id]).toEqual([SITE_ID_BASE + before, SITE_ID_BASE + before + 1, SITE_ID_BASE + before + 2]);
      expect(c.name).toBe(`Gate to ${PEER}:9`);
      // Two gates toward the same neighbour are far outside each other's zone.
      const pa = orbitState(a.orbit, 0).pos;
      const pb = orbitState(b.orbit, 0).pos;
      expect(v3.dist(pa, pb)).toBeGreaterThan(100 * DEFAULT_SITE_FRAME_RADIUS);
      expect(sys.tags.filter((t) => t === 'gate')).toHaveLength(1);
      expect(new Set(sys.sites.map((s) => s.name)).size).toBe(sys.sites.length - 1);
    }
  });

  it('orbits the primary beyond the outermost planet, belt and site', () => {
    for (const sys of sector()) {
      const extent = extentOf(sys);
      const site = upsertGateSite(sys, gate('link-1'), [0.3, 0.1, -0.9]);
      expect(site.orbit.a).toBeGreaterThan(extent * 1.2);
      // Slow enough to stay on the side facing its partner for years.
      expect(site.orbit.period).toBeGreaterThanOrEqual(60 * YEAR * 0.999);
    }
  });

  it('stays inside the region the primary controls in a binary system', () => {
    let binaries = 0;
    for (let k = 0; k < 400 && binaries < 12; k++) {
      const sys = generateSystem(`binaryserver${k}`, 'binary', 7, [0, 0, 0]);
      if (!sys.tags.includes('binary')) continue;
      binaries++;
      const companion = sys.bodies[1]!;
      const extent = extentOf(sys);
      for (const linkId of ['a', 'b', 'c']) {
        const site = upsertGateSite(sys, gate(linkId), [1, 0, 1]);
        expect(site.orbit.a).toBeGreaterThan(extent * 1.2);
        expect(site.orbit.a).toBeLessThan(companion.orbit!.a * (1 - companion.orbit!.e) - soiRadius(sys, 1));
      }
    }
    expect(binaries).toBe(12);
  });

  it('starts on the side facing the far end', () => {
    const directions: Vec3[] = [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1], [3, 5, -4], [-0.2, -0.9, 0.3], [120, 3, 77]];
    for (const towards of directions) {
      const sys = generateSystem(SERVER, 'gates', 2, [0, 0, 0]);
      const site = upsertGateSite(sys, gate('link-1'), towards);
      const pos = orbitState(site.orbit, 0).pos;
      const flat = v3.normalize([towards[0], 0, towards[2]]);
      expect(v3.dot(v3.normalize(pos), flat)).toBeGreaterThan(0.999);
      expect(Math.abs(pos[1])).toBeLessThan(1e-6 * site.orbit.a);
      // A year later it has drifted by a few degrees at most.
      expect(v3.dot(v3.normalize(orbitState(site.orbit, YEAR).pos), flat)).toBeGreaterThan(0.99);
    }
  });

  it('is deterministic for both the direction and the link id', () => {
    const make = (linkId: string, towards: Vec3): unknown => {
      const sys = generateSystem(SERVER, 'gates', 4, [0, 0, 0]);
      return upsertGateSite(sys, gate(linkId), towards);
    };
    expect(make('link-1', [1, 2, 3])).toEqual(make('link-1', [1, 2, 3]));
    expect(make('link-1', [1, 2, 3])).not.toEqual(make('link-2', [1, 2, 3]));
    expect(make('link-1', [1, 2, 3])).not.toEqual(make('link-1', [-1, 2, 3]));
    // Scaling the direction does not move the gate.
    expect(make('link-1', [1, 2, 3])).toEqual(make('link-1', [10, 20, 30]));
  });

  it('copes with a vertical or zero direction', () => {
    for (const towards of [[0, 1, 0], [0, 0, 0], [0, -7, 0]] as Vec3[]) {
      const a = generateSystem(SERVER, 'gates', 6, [0, 0, 0]);
      const b = generateSystem(SERVER, 'gates', 6, [0, 0, 0]);
      const site = upsertGateSite(a, gate('link-1'), towards);
      expect(v3.isFinite(orbitState(site.orbit, 0).pos)).toBe(true);
      expect(Number.isFinite(site.orbit.m0)).toBe(true);
      expect(upsertGateSite(b, gate('link-1'), towards)).toEqual(site);
    }
  });

  it('works in a system without planets', () => {
    let found = 0;
    // Only about one system in a hundred has neither planets nor belts.
    for (let k = 0; k < 3000 && found < 5; k++) {
      const sys = generateSystem(`emptyserver${k}`, 'empty', 9, [0, 0, 0]);
      if (sys.bodies.length !== 1 || sys.belts.length > 0) continue;
      found++;
      const site = upsertGateSite(sys, gate('link-1'), [1, 0, 0]);
      expect(site.orbit.a).toBeGreaterThan(extentOf(sys) * 1.2);
      expect(site.id).toBe(SITE_ID_BASE + sys.sites.length - 1);
    }
    expect(found).toBe(5);
  });
});

describe('summarize', () => {
  it('returns exactly the summary fields of a system', () => {
    for (const sys of sector()) {
      const summary = summarize(sys);
      // A summary counts ground bases among the places to dock and tags their system.
      const bases = sys.sites.filter((s) => s.kind === 'base').length;
      expect(Object.keys(summary).sort()).toEqual(['id', 'name', 'pos', 'security', 'starClass', 'stations', 'tags']);
      expect(summary).toEqual({
        id: sys.id, name: sys.name, pos: sys.pos, starClass: sys.starClass, security: sys.security,
        stations: sys.stations + bases, tags: bases > 0 ? [...sys.tags, 'base'] : sys.tags,
      });
      expect(summary.starClass).toBe(sys.bodies[0]!.cls);
      expect(summary.stations).toBe(sys.sites.filter((s) => s.kind === 'station' || s.kind === 'outpost' || s.kind === 'base').length);
    }
  });

  it('copies positions and tags instead of sharing them', () => {
    const sys = sector()[0]!;
    const summary = summarize(sys);
    expect(summary.pos).not.toBe(sys.pos);
    expect(summary.tags).not.toBe(sys.tags);
    summary.pos[0] += 1;
    summary.tags.push('x');
    expect(summarize(sys)).not.toEqual(summary);
    expect(sys.tags).not.toContain('x');
  });
});
