/**
 * The cube sphere: every direction belongs to one place of one face, the faces are laid out as a
 * GPU cube map looks them up, tiles of a level are about the same size, and a tile's frame is a
 * proper set of axes.
 */
import { describe, expect, it } from 'vitest';
import { FACES, deepestLevel, directionToFace, faceDirection, tileFrame, tileSize, tileSpan } from './cube.ts';

/** A small deterministic generator of numbers in 0..1. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dir = (face: number, u: number, v: number): number[] => {
  const d = [0, 0, 0];
  faceDirection(face, u, v, d);
  return d;
};

/**
 * What the shaders do to find the texel of a direction (`cubeWarp` in shade.ts, then the lookup
 * rule of a cube map): the face, and s and t on it in -1..1.
 */
function gpuLookup(d: number[]): [face: number, s: number, t: number] {
  const m = Math.max(Math.abs(d[0]!), Math.abs(d[1]!), Math.abs(d[2]!));
  const w = d.map((c) => (Math.atan(c / m) * 4) / Math.PI);
  const [x, y, z] = w as [number, number, number];
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ax >= ay && ax >= az) return x > 0 ? [0, -z / ax, -y / ax] : [1, z / ax, -y / ax];
  if (ay >= az) return y > 0 ? [2, x / ay, z / ay] : [3, x / ay, -z / ay];
  return z > 0 ? [4, x / az, -y / az] : [5, -x / az, -y / az];
}

describe('cube sphere', () => {
  it('gives unit directions and finds the face and place of each again', () => {
    const r = rng(1);
    const back = [0, 0, 0];
    for (let n = 0; n < 2000; n++) {
      const face = Math.floor(r() * FACES);
      const u = r() * 1.98 - 0.99;
      const v = r() * 1.98 - 0.99;
      const d = dir(face, u, v);
      expect(Math.hypot(d[0]!, d[1]!, d[2]!)).toBeCloseTo(1, 14);
      directionToFace(d[0]!, d[1]!, d[2]!, back);
      expect(back[0]).toBe(face);
      expect(back[1]).toBeCloseTo(u, 12);
      expect(back[2]).toBeCloseTo(v, 12);
    }
  });

  it('puts the faces where a cube map has them', () => {
    expect(dir(0, 0, 0)).toEqual([1, 0, 0]);
    expect(dir(1, 0, 0)).toEqual([-1, 0, 0]);
    expect(dir(2, 0, 0)).toEqual([0, 1, 0]);
    expect(dir(3, 0, 0)).toEqual([0, -1, 0]);
    expect(dir(4, 0, 0)).toEqual([0, 0, 1]);
    expect(dir(5, 0, 0)).toEqual([0, 0, -1]);
  });

  it('is looked up by the shaders at the texel the bake wrote', () => {
    const r = rng(2);
    for (let n = 0; n < 3000; n++) {
      const face = Math.floor(r() * FACES);
      const u = r() * 1.96 - 0.98;
      const v = r() * 1.96 - 0.98;
      const [f, s, t] = gpuLookup(dir(face, u, v));
      expect(f).toBe(face);
      expect(s).toBeCloseTo(u, 10);
      expect(t).toBeCloseTo(v, 10);
    }
  });

  it('meets its neighbour faces along the edges without a gap', () => {
    const back = [0, 0, 0];
    for (let face = 0; face < FACES; face++) {
      for (const [u, v] of [[1, 0.3], [-1, -0.7], [0.25, 1], [-0.6, -1], [1, 1], [-1, 1]] as const) {
        const d = dir(face, u, v);
        // Whatever face the edge point is counted to, its place there is the same direction.
        directionToFace(d[0]!, d[1]!, d[2]!, back);
        const again = dir(back[0]!, back[1]!, back[2]!);
        for (let c = 0; c < 3; c++) expect(again[c]).toBeCloseTo(d[c]!, 12);
      }
    }
  });

  it('makes the tiles of one level nearly the same size', () => {
    // Edge lengths of all level-4 tiles of a face on the unit sphere, along u.
    const level = 4;
    const span = tileSpan(level);
    let least = Infinity;
    let most = 0;
    for (let iy = 0; iy <= 2 ** level; iy++) {
      for (let ix = 0; ix < 2 ** level; ix++) {
        const a = dir(0, -1 + ix * span, -1 + iy * span);
        const b = dir(0, -1 + (ix + 1) * span, -1 + iy * span);
        const length = Math.acos(Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!));
        least = Math.min(least, length);
        most = Math.max(most, length);
      }
    }
    // The widest tile is the nominal size (a sixteenth of a quarter turn); none is under 0.7 of it.
    expect(most).toBeCloseTo(Math.PI / 2 / 2 ** level, 6);
    expect(least / most).toBeGreaterThan(0.7);
    expect(tileSize(1000, level)).toBeCloseTo(1000 * most, 6);
  });

  it('gives every tile a right-handed frame standing on the mean sphere', () => {
    const r = rng(3);
    const f = new Float64Array(12);
    for (let n = 0; n < 200; n++) {
      const face = Math.floor(r() * FACES);
      const level = Math.floor(r() * 16);
      const ix = Math.floor(r() * 2 ** level);
      const iy = Math.floor(r() * 2 ** level);
      tileFrame(face, level, ix, iy, 1_057_000, f);
      const X = [f[3]!, f[4]!, f[5]!], Y = [f[6]!, f[7]!, f[8]!], Z = [f[9]!, f[10]!, f[11]!];
      const dot = (a: number[], b: number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
      expect(dot(X, X)).toBeCloseTo(1, 12);
      expect(dot(Y, Y)).toBeCloseTo(1, 12);
      expect(dot(Z, Z)).toBeCloseTo(1, 12);
      expect(dot(X, Y)).toBeCloseTo(0, 12);
      expect(dot(Y, Z)).toBeCloseTo(0, 12);
      // Z = X x Y.
      expect(X[1]! * Y[2]! - X[2]! * Y[1]!).toBeCloseTo(Z[0]!, 12);
      expect(X[2]! * Y[0]! - X[0]! * Y[2]!).toBeCloseTo(Z[1]!, 12);
      // The origin is the tile centre on the mean sphere and +Y is straight up there.
      const span = tileSpan(level);
      const c = dir(face, -1 + (ix + 0.5) * span, -1 + (iy + 0.5) * span);
      for (let k = 0; k < 3; k++) {
        expect(f[k]).toBeCloseTo(c[k]! * 1_057_000, 6);
        expect(Y[k]).toBeCloseTo(c[k]!, 12);
      }
    }
  });

  it('ends at cells of one to two and a half metres on any body', () => {
    for (const radius of [341_000, 477_000, 1_057_000, 2_280_000, 8_345_000]) {
      const level = deepestLevel(radius, 32, 1.25);
      const cell = tileSize(radius, level) / 32;
      expect(cell).toBeGreaterThanOrEqual(1.25);
      expect(cell).toBeLessThan(2.5);
    }
  });
});
