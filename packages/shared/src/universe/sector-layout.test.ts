import { describe, expect, it } from 'vitest';
import { CORE_REGION_RADIUS, DEFAULT_SECTOR_RADIUS } from '../constants.ts';
import { v3, type Vec3 } from '../math.ts';
import { Rng } from '../prng.ts';
import {
  chooseSectorCenter, MIN_SYSTEM_SEPARATION_LY, nearestPair, SECTOR_FLATTENING, sectorOffsets, systemEdgeFraction,
  type PlacementArgs, type PlacementPeer,
} from './generate.ts';

const minSeparation = (points: readonly Vec3[]): number => {
  let min = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = 0; j < i; j++) min = Math.min(min, v3.dist(points[i]!, points[j]!));
  }
  return min;
};

describe('sectorOffsets', () => {
  it('keeps every system inside the flattened sector and system 0 near the centre', () => {
    for (let k = 0; k < 30; k++) {
      for (const radius of [8, DEFAULT_SECTOR_RADIUS, 60]) {
        const offsets = sectorOffsets(`server${k}`, `seed${k}`, radius, 64);
        expect(offsets).toHaveLength(64);
        for (const o of offsets) {
          expect(v3.isFinite(o)).toBe(true);
          expect(v3.len(o)).toBeLessThanOrEqual(radius);
          expect(Math.abs(o[1])).toBeLessThanOrEqual(radius * SECTOR_FLATTENING);
          // Inside the ellipsoid with semi-axes (radius, 0.35 radius, radius).
          expect(Math.hypot(o[0], o[1] / SECTOR_FLATTENING, o[2])).toBeLessThanOrEqual(radius * (1 + 1e-12));
        }
        expect(v3.len(offsets[0]!)).toBeLessThanOrEqual(0.15 * radius);
      }
    }
  });

  it('respects the minimum separation of 2 light years in a sector of default size', () => {
    expect(MIN_SYSTEM_SEPARATION_LY).toBe(2);
    let tightest = Infinity;
    for (let k = 0; k < 60; k++) {
      const offsets = sectorOffsets(`sep-server-${k}`, `sep-seed-${k}`, DEFAULT_SECTOR_RADIUS, 64);
      tightest = Math.min(tightest, minSeparation(offsets));
    }
    expect(tightest).toBeGreaterThanOrEqual(MIN_SYSTEM_SEPARATION_LY);
  });

  it('is index-stable: offset i never depends on the count', () => {
    for (let k = 0; k < 10; k++) {
      const full = sectorOffsets(`stable${k}`, 'seed', DEFAULT_SECTOR_RADIUS, 64);
      for (const count of [0, 1, 2, 8, 33]) {
        expect(sectorOffsets(`stable${k}`, 'seed', DEFAULT_SECTOR_RADIUS, count)).toEqual(full.slice(0, count));
      }
    }
  });

  it('is deterministic and depends on server id, seed and radius', () => {
    const base = sectorOffsets('server', 'seed', 18, 20);
    expect(sectorOffsets('server', 'seed', 18, 20)).toEqual(base);
    expect(sectorOffsets('server2', 'seed', 18, 20)).not.toEqual(base);
    expect(sectorOffsets('server', 'seed2', 18, 20)).not.toEqual(base);
    expect(sectorOffsets('server', 'seed', 19, 20)).not.toEqual(base);
  });

  it('places each system on the shell given by systemEdgeFraction', () => {
    for (const radius of [5, 18, 90]) {
      const offsets = sectorOffsets('shellserver', 'shell', radius, 64);
      offsets.forEach((o, i) => {
        const fraction = Math.hypot(o[0], o[1] / SECTOR_FLATTENING, o[2]) / radius;
        expect(fraction).toBeCloseTo(systemEdgeFraction('shellserver', 'shell', i), 10);
      });
    }
    for (let i = 0; i < 200; i++) {
      const f = systemEdgeFraction('shellserver', 'shell', i);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      if (i === 0) expect(f).toBeLessThan(0.15);
    }
  });

  it('fills the whole sector, flattened along Y', () => {
    const offsets = Array.from({ length: 20 }, (_, k) => sectorOffsets(`fill${k}`, 'fill', 18, 64)).flat();
    const spread = (axis: number): number => Math.sqrt(offsets.reduce((s, o) => s + o[axis]! * o[axis]!, 0) / offsets.length);
    expect(Math.max(...offsets.map((o) => v3.len(o)))).toBeGreaterThan(0.95 * 18);
    expect(spread(0) / spread(2)).toBeGreaterThan(0.85);
    expect(spread(0) / spread(2)).toBeLessThan(1.18);
    expect(spread(1) / spread(0)).toBeGreaterThan(SECTOR_FLATTENING * 0.85);
    expect(spread(1) / spread(0)).toBeLessThan(SECTOR_FLATTENING * 1.18);
    // Every octant of the sector is populated.
    const octants = new Set(offsets.map((o) => (o[0] > 0 ? 1 : 0) + (o[1] > 0 ? 2 : 0) + (o[2] > 0 ? 4 : 0)));
    expect(octants.size).toBe(8);
  });

  it('relaxes the separation only when the sector is too small, and still stays inside', () => {
    const tiny = sectorOffsets('tiny', 'tiny', 2, 40);
    expect(tiny).toHaveLength(40);
    for (const o of tiny) expect(v3.len(o)).toBeLessThanOrEqual(2);
    // 40 systems cannot keep 2 ly apart inside a radius of 2 ly, but no two coincide.
    expect(minSeparation(tiny)).toBeGreaterThan(0.01);
    expect(minSeparation(tiny)).toBeLessThan(MIN_SYSTEM_SEPARATION_LY);
    expect(sectorOffsets('tiny', 'tiny', 2, 12)).toEqual(tiny.slice(0, 12));
    // The first systems of a small sector still get the full separation.
    expect(minSeparation(sectorOffsets('tiny', 'tiny', 6, 5))).toBeGreaterThanOrEqual(MIN_SYSTEM_SEPARATION_LY);
  });
});

describe('nearestPair', () => {
  it('returns null when either side is empty', () => {
    expect(nearestPair([], [{ pos: [0, 0, 0] as Vec3 }])).toBeNull();
    expect(nearestPair([{ pos: [0, 0, 0] as Vec3 }], [])).toBeNull();
    expect(nearestPair([], [])).toBeNull();
  });

  it('finds the closest pair and returns the original elements', () => {
    const a = [{ pos: [0, 0, 0] as Vec3, tag: 'a0' }, { pos: [10, 0, 0] as Vec3, tag: 'a1' }];
    const b = [{ pos: [100, 0, 0] as Vec3, id: 0 }, { pos: [10, 3, 4] as Vec3, id: 1 }, { pos: [0, 0, 9] as Vec3, id: 2 }];
    const pair = nearestPair(a, b)!;
    expect(pair.a).toBe(a[1]);
    expect(pair.b).toBe(b[1]);
    expect(pair.dist).toBeCloseTo(5, 12);
  });

  it('agrees with brute force on random sets', () => {
    const rng = new Rng('pairs');
    for (let round = 0; round < 20; round++) {
      const make = (n: number): { pos: Vec3 }[] =>
        Array.from({ length: n }, () => ({ pos: [rng.range(-50, 50), rng.range(-10, 10), rng.range(-50, 50)] as Vec3 }));
      const a = make(rng.int(1, 30));
      const b = make(rng.int(1, 30));
      let best = Infinity;
      for (const x of a) for (const y of b) best = Math.min(best, v3.dist(x.pos, y.pos));
      const pair = nearestPair(a, b)!;
      expect(pair.dist).toBeCloseTo(best, 10);
      expect(v3.dist(pair.a.pos, pair.b.pos)).toBeCloseTo(best, 10);
    }
  });
});

describe('chooseSectorCenter', () => {
  const peerCenter: Vec3 = [40, 2, -30];
  const peer: PlacementPeer = {
    pos: peerCenter,
    radius: DEFAULT_SECTOR_RADIUS,
    systems: sectorOffsets('peerserverpeerse', 'peer', DEFAULT_SECTOR_RADIUS, 32).map((o) => ({ pos: v3.add(peerCenter, o) })),
  };
  const argsFor = (serverId: string, over: Partial<PlacementArgs> = {}): PlacementArgs => ({
    serverId,
    offsets: sectorOffsets(serverId, 'own', DEFAULT_SECTOR_RADIUS, 24),
    radius: DEFAULT_SECTOR_RADIUS,
    peer,
    others: [],
    reach: 9,
    ...over,
  });
  const pairDistance = (args: PlacementArgs, center: Vec3): number =>
    nearestPair(args.offsets.map((o) => ({ pos: v3.add(center, o) })), args.peer!.systems)!.dist;
  const SERVER_IDS = Array.from({ length: 16 }, (_, k) => `placement-server-${k}`);

  it('with a peer, puts the closest pair of systems between 0.5 and 0.9 of the jump range apart', () => {
    for (const serverId of SERVER_IDS) {
      for (const reach of [9, 7.5, 12, 24, 3]) {
        const args = argsFor(serverId, { reach });
        const center = chooseSectorCenter(args);
        expect(v3.isFinite(center)).toBe(true);
        const d = pairDistance(args, center);
        expect(d).toBeGreaterThanOrEqual(0.5 * reach);
        expect(d).toBeLessThanOrEqual(0.9 * reach);
      }
    }
  });

  it('sits beside the peer, close to the galactic plane', () => {
    const directions = new Set<string>();
    for (const serverId of SERVER_IDS) {
      const center = chooseSectorCenter(argsFor(serverId));
      const delta = v3.sub(center, peerCenter);
      const distance = v3.len(delta);
      // The two sectors touch: their centres are about two radii apart.
      expect(distance).toBeGreaterThan(DEFAULT_SECTOR_RADIUS * 0.4);
      expect(distance).toBeLessThan(2 * DEFAULT_SECTOR_RADIUS + 9);
      expect(Math.abs(delta[1]) / distance).toBeLessThan(0.16);
      directions.add(`${Math.round(Math.atan2(delta[2], delta[0]) * 4)}`);
    }
    // Different servers settle on different sides of the peer.
    expect(directions.size).toBeGreaterThan(5);
  });

  it('is deterministic with and without a peer', () => {
    for (const serverId of SERVER_IDS.slice(0, 6)) {
      expect(chooseSectorCenter(argsFor(serverId))).toEqual(chooseSectorCenter(argsFor(serverId)));
      const alone = argsFor(serverId, { peer: null });
      expect(chooseSectorCenter(alone)).toEqual(chooseSectorCenter(alone));
    }
  });

  it('without a peer, picks a spot inside the flattened core region', () => {
    const spots: Vec3[] = [];
    for (let k = 0; k < 200; k++) {
      const center = chooseSectorCenter(argsFor(`standalone-${k}`, { peer: null, offsets: [] }));
      expect(v3.isFinite(center)).toBe(true);
      expect(v3.len(center)).toBeLessThanOrEqual(CORE_REGION_RADIUS);
      expect(Math.abs(center[1])).toBeLessThanOrEqual(0.06 * CORE_REGION_RADIUS);
      spots.push(center);
    }
    // Different server ids land in different places, spread over the whole disc.
    expect(minSeparation(spots)).toBeGreaterThan(0);
    expect(Math.max(...spots.map((s) => Math.hypot(s[0], s[2])))).toBeGreaterThan(0.75 * CORE_REGION_RADIUS);
    expect(spots.filter((s) => Math.hypot(s[0], s[2]) < 0.5 * CORE_REGION_RADIUS).length).toBeGreaterThan(20);
  });

  it('moves elsewhere when another sector sits on the first candidate spot', () => {
    for (const serverId of SERVER_IDS.slice(0, 8)) {
      const args = argsFor(serverId);
      const first = chooseSectorCenter(args);
      const blocked = argsFor(serverId, { others: [{ pos: first, radius: DEFAULT_SECTOR_RADIUS }] });
      const second = chooseSectorCenter(blocked);
      expect(second).not.toEqual(first);
      // Clear of the blocking sector, and still within jump range of the peer.
      expect(v3.dist(second, first)).toBeGreaterThanOrEqual(0.75 * 2 * DEFAULT_SECTOR_RADIUS);
      const d = pairDistance(blocked, second);
      expect(d).toBeGreaterThanOrEqual(0.5 * 9);
      expect(d).toBeLessThanOrEqual(0.9 * 9);
      expect(chooseSectorCenter(blocked)).toEqual(second);

      const alone = argsFor(serverId, { peer: null });
      const firstAlone = chooseSectorCenter(alone);
      const secondAlone = chooseSectorCenter({ ...alone, others: [{ pos: firstAlone, radius: DEFAULT_SECTOR_RADIUS }] });
      expect(secondAlone).not.toEqual(firstAlone);
      expect(v3.dist(secondAlone, firstAlone)).toBeGreaterThanOrEqual(0.75 * 2 * DEFAULT_SECTOR_RADIUS);
      expect(v3.len(secondAlone)).toBeLessThanOrEqual(CORE_REGION_RADIUS);
    }
  });

  it('ignores the peer itself when it is listed among the other sectors', () => {
    const args = argsFor(SERVER_IDS[0]!);
    const first = chooseSectorCenter(args);
    expect(chooseSectorCenter({ ...args, others: [{ pos: [...peerCenter] as Vec3, radius: peer.radius }] })).toEqual(first);
  });

  it('settles for the least crowded spot when every direction is taken', () => {
    const args = argsFor(SERVER_IDS[1]!, { others: [{ pos: [peerCenter[0] + 0.5, peerCenter[1], peerCenter[2]], radius: 400 }] });
    const center = chooseSectorCenter(args);
    expect(v3.isFinite(center)).toBe(true);
    const d = pairDistance(args, center);
    expect(d).toBeGreaterThanOrEqual(0.5 * 9);
    expect(d).toBeLessThanOrEqual(0.9 * 9);
    expect(chooseSectorCenter(args)).toEqual(center);
  });

  it('copes with sectors of a single system and with a peer that lists none', () => {
    const lonely: PlacementPeer = { pos: [5, 0, 5], radius: 18, systems: [{ pos: [5, 0, 5] }] };
    const args = argsFor('single', { peer: lonely, offsets: [[0.5, 0.1, -0.5]] });
    const center = chooseSectorCenter(args);
    const d = pairDistance(args, center);
    expect(d).toBeGreaterThanOrEqual(4.5);
    expect(d).toBeLessThanOrEqual(8.1);

    const empty = chooseSectorCenter(argsFor('single', { peer: { pos: [5, 0, 5], radius: 18, systems: [] }, offsets: [] }));
    expect(v3.isFinite(empty)).toBe(true);
    expect(v3.dist(empty, [5, 0, 5])).toBeGreaterThanOrEqual(4.5);
    expect(v3.dist(empty, [5, 0, 5])).toBeLessThanOrEqual(8.1);
  });
});
