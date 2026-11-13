/**
 * The bake: what is drawn must be the shared terrain. The vertices of a tile are samples of
 * `terrainHeight` (at the deepest levels exactly the ground ships collide with), a child's
 * coarse surface is its parent's mesh, neighbours agree along their edge, the normals of the map
 * are the terrain's slopes, and the far map holds the same ground.
 */
import { describe, expect, it } from 'vitest';
import { terrainHeight, terrainNormal, terrainParams, terrainSample, type Vec3 } from '@primacy2/shared';
import {
  bakeFarRows, bakeTile, fromHalf, gridDetail, skirtAnchor, skirtDepth, tileIndexCount, tileIndices, tileUvs, tileVertexCount, toHalf,
  type TileBake, type TileSpec,
} from './bake.ts';
import { deepestLevel, faceDirection, tileSize, tileSpan } from './cube.ts';

const RADIUS = 1_057_000;
const rocky = terrainParams({ seed: 20_161, cls: 'rocky', radius: RADIUS });
const ice = terrainParams({ seed: 77, cls: 'ice', radius: 477_000 });

const spec = (face: number, level: number, ix: number, iy: number, cells: number, texels: number, radius = RADIUS): TileSpec => ({
  face, level, ix, iy, cells, texels, parentDetail: level > 0 ? gridDetail(radius, level - 1, cells, texels) : 0,
});

/** A vertex of a baked tile (its own or its coarse position) in body-fixed axes. */
function bodyPoint(b: TileBake, from: Float32Array, k: number): Vec3 {
  const f = b.frame;
  const x = from[k * 3]!, y = from[k * 3 + 1]!, z = from[k * 3 + 2]!;
  return [f[0]! + x * f[3]! + y * f[6]! + z * f[9]!, f[1]! + x * f[4]! + y * f[7]! + z * f[10]!, f[2]! + x * f[5]! + y * f[8]! + z * f[11]!];
}

/** The unit direction of grid vertex (i, j) of a tile. */
function vertexDir(s: TileSpec, i: number, j: number): Vec3 {
  const span = tileSpan(s.level);
  const d: Vec3 = [0, 0, 0];
  faceDirection(s.face, -1 + (s.ix + i / s.cells) * span, -1 + (s.iy + j / s.cells) * span, d);
  return d;
}

/** The normal a map texel holds, in body-fixed axes. */
function mapNormal(b: TileBake, i: number, j: number): Vec3 {
  const o = (j * b.mapSize + i) * 4;
  const x = fromHalf(b.map[o]!), z = fromHalf(b.map[o + 1]!);
  const y = Math.sqrt(Math.max(0, 1 - x * x - z * z));
  const f = b.frame;
  return [x * f[3]! + y * f[6]! + z * f[9]!, x * f[4]! + y * f[7]! + z * f[10]!, x * f[5]! + y * f[8]! + z * f[11]!];
}

const angle = (a: Vec3, b: Vec3): number =>
  (Math.acos(Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b)))) * 180) / Math.PI;

describe('half floats', () => {
  it('round to the nearest 16-bit float', () => {
    for (const v of [0, 1, -1, 0.5, -0.25, 1024, 65504, 2 ** -14, 2 ** -24, -(2 ** -20)]) expect(fromHalf(toHalf(v))).toBe(v);
    for (let k = 0; k < 2000; k++) {
      const v = Math.sin(k * 12.9898) * 10 ** ((k % 9) - 5);
      const back = fromHalf(toHalf(v));
      // Eleven bits of mantissa, or the spacing of the smallest halves.
      expect(Math.abs(back - v)).toBeLessThanOrEqual(Math.max(Math.abs(v) * 2 ** -11, 2 ** -25));
    }
    expect(fromHalf(toHalf(1e9))).toBe(Infinity);
    expect(fromHalf(toHalf(1e-12))).toBe(0);
  });
});

describe('tile mesh layout', () => {
  it('draws every triangle once in each order, facing outward, with the skirt first', () => {
    const cells = 8;
    const row = cells + 1;
    const index = tileIndices(cells);
    const per = tileIndexCount(cells);
    const b = bakeTile(rocky, spec(2, 6, 11, 40, cells, 2));
    const key = (o: number): string => [index[o]!, index[o + 1]!, index[o + 2]!].join(',');
    const first = new Set<string>();
    for (let o = 0; o < per; o += 3) first.add(key(o));
    expect(first.size).toBe(per / 3);
    expect(index.length % per).toBe(0);
    for (let order = 0; order < index.length / per; order++) {
      for (let o = 0; o < per; o += 3) {
        expect(first.has(key(order * per + o))).toBe(true);
        const skirt = index[order * per + o + 2]! >= row * row || index[order * per + o + 1]! >= row * row;
        // The skirt comes before the surface in every order.
        expect(skirt).toBe(o < 4 * cells * 6);
      }
    }
    // Surface triangles turn counter-clockwise seen from outside the body.
    for (let o = 4 * cells * 6; o < per; o += 3) {
      const p = [0, 1, 2].map((c) => bodyPoint(b, b.positions, index[o + c]!));
      const e1 = [p[1]![0] - p[0]![0], p[1]![1] - p[0]![1], p[1]![2] - p[0]![2]];
      const e2 = [p[2]![0] - p[0]![0], p[2]![1] - p[0]![1], p[2]![2] - p[0]![2]];
      const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      expect(n[0]! * p[0]![0] + n[1]! * p[0]![1] + n[2]! * p[0]![2]).toBeGreaterThan(0);
    }
    // Skirt triangles face away from the middle of the tile.
    const middle = bodyPoint(b, b.positions, (cells / 2) * row + cells / 2);
    for (let o = 0; o < 4 * cells * 6; o += 3) {
      const p = [0, 1, 2].map((c) => bodyPoint(b, b.positions, index[o + c]!));
      const e1 = [p[1]![0] - p[0]![0], p[1]![1] - p[0]![1], p[1]![2] - p[0]![2]];
      const e2 = [p[2]![0] - p[0]![0], p[2]![1] - p[0]![1], p[2]![2] - p[0]![2]];
      const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      expect(n[0]! * (p[0]![0] - middle[0]) + n[1]! * (p[0]![1] - middle[1]) + n[2]! * (p[0]![2] - middle[2])).toBeGreaterThan(0);
    }
  });

  it('hangs a skirt vertex straight below every edge vertex', () => {
    const cells = 8;
    const row = cells + 1;
    const s = spec(4, 9, 300, 17, cells, 2);
    const b = bakeTile(rocky, s);
    const uv = tileUvs(cells);
    const depth = skirtDepth(RADIUS, s.level, cells);
    expect(b.positions.length).toBe(tileVertexCount(cells) * 3);
    const seen = new Set<number>();
    for (let k = 0; k < 4 * row; k++) {
      const a = skirtAnchor(k, cells);
      seen.add(a);
      const i = a % row, j = Math.floor(a / row);
      expect(i === 0 || j === 0 || i === cells || j === cells).toBe(true);
      const top = bodyPoint(b, b.positions, a);
      const low = bodyPoint(b, b.positions, row * row + k);
      const d = vertexDir(s, i, j);
      for (let c = 0; c < 3; c++) expect(top[c]! - low[c]!).toBeCloseTo(d[c]! * depth, 2);
      expect(uv[(row * row + k) * 2]).toBe(uv[a * 2]);
      expect(uv[(row * row + k) * 2 + 1]).toBe(uv[a * 2 + 1]);
      expect(b.heights[(row * row + k) * 2]).toBe(b.heights[a * 2]);
    }
    // Every edge vertex has one.
    expect(seen.size).toBe(4 * cells);
  });
});

describe('baked tiles', () => {
  it('have their vertices on the shared terrain', () => {
    for (const [p, radius, s] of [
      [rocky, RADIUS, spec(0, 0, 0, 0, 16, 2)],
      [rocky, RADIUS, spec(3, 5, 9, 22, 16, 4)],
      [rocky, RADIUS, spec(5, 11, 1500, 77, 16, 4)],
      [ice, 477_000, spec(1, 8, 100, 200, 16, 2, 477_000)],
    ] as const) {
      const b = bakeTile(p, s);
      const detail = gridDetail(radius, s.level, s.cells, s.texels);
      const row = s.cells + 1;
      let lo = Infinity, hi = -Infinity;
      for (let j = 0; j < row; j++) {
        for (let i = 0; i < row; i++) {
          const d = vertexDir(s, i, j);
          const h = terrainHeight(p, d[0], d[1], d[2], detail);
          const k = j * row + i;
          expect(b.heights[k * 2]).toBeCloseTo(h, 2);
          // The position is that height along that direction; float32 in the tile frame costs
          // a ten-millionth of the tile's size.
          const at = bodyPoint(b, b.positions, k);
          const slack = Math.max(1e-3, tileSize(radius, s.level) * 4e-7);
          for (let c = 0; c < 3; c++) expect(Math.abs(at[c]! - d[c]! * (radius + h))).toBeLessThan(slack);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
      }
      expect(b.minH).toBeCloseTo(lo, 2);
      expect(b.maxH).toBeCloseTo(hi, 2);
    }
  });

  it('are exactly the ground ships collide with at the deep levels', () => {
    const deepest = deepestLevel(RADIUS, 32, 1.25);
    for (const level of [deepest, deepest - 1, deepest - 2]) {
      const s = spec(2, level, 2 ** (level - 1) + 5, 2 ** (level - 1) - 9, 32, level === deepest ? 2 : 4);
      expect(gridDetail(RADIUS, level, 32, s.texels)).toBe(0);
      const b = bakeTile(rocky, s);
      for (const [i, j] of [[0, 0], [7, 19], [32, 32], [16, 1], [31, 30]] as const) {
        const d = vertexDir(s, i, j);
        // Detail 0 is the function of the simulation; the vertex holds it to float32.
        expect(b.heights[(j * 33 + i) * 2]).toBe(Math.fround(terrainHeight(rocky, d[0], d[1], d[2])));
        const at = bodyPoint(b, b.positions, j * 33 + i);
        expect(Math.hypot(...at) - RADIUS).toBeCloseTo(terrainHeight(rocky, d[0], d[1], d[2]), 3);
      }
    }
  });

  it('give a child the mesh of its parent as its coarse surface', () => {
    const cells = 16;
    const row = cells + 1;
    for (const [level, px, py] of [[1, 0, 1], [6, 21, 40], [12, 2000, 1000]] as const) {
      const parent = bakeTile(rocky, spec(4, level - 1, px, py, cells, 2));
      for (let q = 0; q < 4; q++) {
        const qx = q & 1, qy = q >> 1;
        const child = bakeTile(rocky, spec(4, level, px * 2 + qx, py * 2 + qy, cells, 2));
        const slack = Math.max(2e-3, tileSize(RADIUS, level - 1) * 1e-6);
        const parentAt = (i: number, j: number): Vec3 => bodyPoint(parent, parent.positions, (qy * (cells / 2) + j) * row + qx * (cells / 2) + i);
        for (let j = 0; j < row; j++) {
          for (let i = 0; i < row; i++) {
            const got = bodyPoint(child, child.coarse, j * row + i);
            let want: Vec3;
            if (i % 2 === 0 && j % 2 === 0) {
              want = parentAt(i / 2, j / 2);
            } else {
              // Halfway between two parent vertices: along an edge, or along the diagonal the cells are cut on.
              const a = i % 2 && j % 2 ? parentAt((i + 1) / 2, (j - 1) / 2) : i % 2 ? parentAt((i - 1) / 2, j / 2) : parentAt(i / 2, (j - 1) / 2);
              const b = i % 2 && j % 2 ? parentAt((i - 1) / 2, (j + 1) / 2) : i % 2 ? parentAt((i + 1) / 2, j / 2) : parentAt(i / 2, (j + 1) / 2);
              want = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
            }
            for (let c = 0; c < 3; c++) expect(Math.abs(got[c]! - want[c]!)).toBeLessThan(slack);
          }
        }
        // And the height it flattens by is the parent's.
        expect(child.heights[1]).toBeCloseTo(parent.heights[((qy * (cells / 2)) * row + qx * (cells / 2)) * 2]!, 2);
      }
    }
  });

  it('agree with their neighbour along the common edge, in the mesh and in the map', () => {
    const cells = 16;
    const row = cells + 1;
    for (const [level, ix, iy] of [[3, 2, 5], [9, 100, 301], [14, 5000, 9000]] as const) {
      const a = bakeTile(rocky, spec(0, level, ix, iy, cells, 4));
      const right = bakeTile(rocky, spec(0, level, ix + 1, iy, cells, 4));
      const above = bakeTile(rocky, spec(0, level, ix, iy + 1, cells, 4));
      const slack = Math.max(2e-3, tileSize(RADIUS, level) * 1e-6);
      for (let k = 0; k < row; k++) {
        const p = bodyPoint(a, a.positions, k * row + cells), q = bodyPoint(right, right.positions, k * row);
        const r = bodyPoint(a, a.positions, cells * row + k), s = bodyPoint(above, above.positions, k);
        for (let c = 0; c < 3; c++) {
          expect(Math.abs(p[c]! - q[c]!)).toBeLessThan(slack);
          expect(Math.abs(r[c]! - s[c]!)).toBeLessThan(slack);
        }
      }
      const g = a.mapSize - 1;
      for (let k = 0; k <= g; k += 3) {
        expect(angle(mapNormal(a, g, k), mapNormal(right, 0, k))).toBeLessThan(0.05);
        expect(angle(mapNormal(a, k, g), mapNormal(above, k, 0))).toBeLessThan(0.05);
        expect(fromHalf(a.map[(k * a.mapSize + g) * 4 + 2]!)).toBeCloseTo(fromHalf(right.map[(k * a.mapSize) * 4 + 2]!), 5);
      }
    }
  });

  it('hold the slopes and the tone of the terrain in their map', () => {
    for (const [p, radius, s] of [[rocky, RADIUS, spec(1, 7, 60, 33, 16, 4)], [rocky, RADIUS, spec(2, 12, 999, 2111, 16, 4)], [ice, 477_000, spec(5, 6, 20, 41, 16, 4, 477_000)]] as const) {
      const b = bakeTile(p, s);
      const g = b.mapSize - 1;
      const detail = gridDetail(radius, s.level, s.cells, s.texels);
      const texel = tileSize(radius, s.level) / g;
      const span = tileSpan(s.level);
      const want: Vec3 = [0, 0, 0];
      const sample = [0, 0];
      let worst = 0;
      let sum = 0;
      let count = 0;
      for (let j = 2; j < g; j += 7) {
        for (let i = 2; i < g; i += 7) {
          const d: Vec3 = [0, 0, 0];
          faceDirection(s.face, -1 + (s.ix + i / g) * span, -1 + (s.iy + j / g) * span, d);
          // The shared normal over the same two texels the map's difference spans.
          terrainNormal(p, d[0], d[1], d[2], 2 * texel, want, detail);
          const off = angle(mapNormal(b, i, j), want);
          worst = Math.max(worst, off);
          sum += off;
          count++;
          terrainSample(p, d[0], d[1], d[2], detail, sample);
          expect(fromHalf(b.map[(j * b.mapSize + i) * 4 + 2]!)).toBeCloseTo(sample[1]!, 3);
        }
      }
      // The two are differences along differently turned axes, so they part a little where the
      // ground bends within a texel (a crater rim); on the whole they are the same slopes.
      expect(sum / count).toBeLessThan(0.5);
      expect(worst).toBeLessThan(12);
    }
  });
});

describe('far map', () => {
  it('is the same whether a face is baked whole or in strips', () => {
    const whole = bakeFarRows(rocky, 3, 32, 0, 32);
    const top = bakeFarRows(rocky, 3, 32, 0, 12);
    const rest = bakeFarRows(rocky, 3, 32, 12, 20);
    expect(Array.from(whole.subarray(0, top.length))).toEqual(Array.from(top));
    expect(Array.from(whole.subarray(top.length))).toEqual(Array.from(rest));
  });

  it('holds the normal and the tone of the terrain at the centre of each texel', () => {
    const size = 64;
    const detail = (2 * tileSize(RADIUS, 0)) / size;
    for (const face of [0, 3, 4]) {
      const data = bakeFarRows(rocky, face, size, 0, size);
      const want: Vec3 = [0, 0, 0];
      const sample = [0, 0];
      let sum = 0;
      let count = 0;
      for (let j = 1; j < size; j += 5) {
        for (let i = 1; i < size; i += 5) {
          const d: Vec3 = [0, 0, 0];
          faceDirection(face, -1 + ((i + 0.5) * 2) / size, -1 + ((j + 0.5) * 2) / size, d);
          const o = (j * size + i) * 4;
          // The shader's way back from the stored slope vector to the normal.
          const n: Vec3 = [d[0] + fromHalf(data[o]!), d[1] + fromHalf(data[o + 1]!), d[2] + fromHalf(data[o + 2]!)];
          terrainNormal(rocky, d[0], d[1], d[2], (2 * tileSize(RADIUS, 0)) / size, want, detail);
          sum += angle(n, want);
          count++;
          terrainSample(rocky, d[0], d[1], d[2], detail, sample);
          expect(fromHalf(data[o + 3]!)).toBeCloseTo(sample[1]!, 3);
        }
      }
      expect(sum / count).toBeLessThan(1);
    }
  });
});
