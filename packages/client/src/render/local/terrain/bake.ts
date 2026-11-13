/**
 * Turns the shared terrain function into what the GPU draws: the mesh and the normal and tone map
 * of one quadtree tile, and strips of the coarse map of a whole body for the far view. This is
 * the only place heights, normals and tones are made; every one of them is a sample of
 * `terrainSample`, or a difference of two samples. It runs in the worker (`worker.ts`); the main
 * thread only uploads the arrays.
 *
 * A tile is sampled on one square grid of `cells * texels` steps per edge, with one more ring of
 * samples around it. The map has a texel at every grid point, so the texels on a shared edge of
 * two tiles are the same points and get the same values. The mesh takes every `texels`-th point
 * as a vertex. Normals are differences of the neighbouring points in 3D, so they include the
 * curve of the sphere and need no samples of their own.
 *
 * The grid is sampled with the terrain's `detail` set to twice its spacing: anything smaller the
 * grid could not show and would turn into noise. At the fine levels that is below the smallest
 * feature the terrain has (10 m), and the samples are exactly the ground ships collide with.
 */
// Straight from the terrain's own file, not through the index of the shared package: this module
// is the worker's, and the worker should carry the terrain and nothing else of the game.
import { terrainSample, type TerrainParams } from '../../../../../shared/src/universe/terrain.ts';
import { facePoint, faceTangent, tileFrame, tileSize, tileSpan } from './cube.ts';

/** Features below this size do not exist in the terrain: a `detail` up to it changes nothing. */
const FULL_DETAIL = 10;

/** What one tile is asked for. */
export interface TileSpec {
  face: number;
  level: number;
  ix: number;
  iy: number;
  /** Mesh cells along an edge (even). */
  cells: number;
  /** Map texels per mesh cell along an edge. */
  texels: number;
  /** `detail` of the parent tile's grid, for the surface this tile turns into at a distance; 0 = full. */
  parentDetail: number;
}

/** A baked tile. Vertices are in the tile's own frame (`tileFrame`), metres, as float32. */
export interface TileBake {
  /** Vertex positions: the `(cells + 1)^2` grid row by row, then the skirt ring. */
  positions: Float32Array;
  /** Per vertex, where it lies on the parent tile's surface: what the vertex moves to at a distance. */
  coarse: Float32Array;
  /** Per vertex: its height above the mean radius and the height of its place on the parent's surface, metres. */
  heights: Float32Array;
  /** `mapSize^2` texels of four half floats: normal x and z in the tile frame, tone, 1. */
  map: Uint16Array;
  mapSize: number;
  /** Origin and axes of the tile frame in body-fixed axes (see `tileFrame`). */
  frame: Float64Array;
  /** Lowest and highest vertex height, metres. */
  minH: number;
  maxH: number;
  /** Box around the surface vertices in the tile frame: min x, y, z, max x, y, z. */
  box: Float32Array;
}

/** Twice the spacing of a tile's sample grid, or 0 where that is finer than the terrain itself. */
export function gridDetail(radius: number, level: number, cells: number, texels: number): number {
  const detail = (2 * tileSize(radius, level)) / (cells * texels);
  return detail <= FULL_DETAIL ? 0 : detail;
}

/** How far the skirt of a tile hangs below its edge, metres: a cell and a half. */
export const skirtDepth = (radius: number, level: number, cells: number): number => (1.5 * tileSize(radius, level)) / cells;

/** Vertices of a tile mesh: the grid and a skirt vertex under every edge vertex (corners twice). */
export const tileVertexCount = (cells: number): number => (cells + 1) * (cells + 1) + 4 * (cells + 1);

/** Grid index of the edge vertex that skirt vertex `k` hangs under. The ring runs along u at v = -1, up, back, down. */
export function skirtAnchor(k: number, cells: number): number {
  const row = cells + 1;
  const side = Math.floor(k / row);
  const i = k - side * row;
  if (side === 0) return i;
  if (side === 1) return i * row + cells;
  if (side === 2) return cells * row + (cells - i);
  return (cells - i) * row;
}

/** Indices of one drawing order of a tile mesh: the skirt and the surface. */
export const tileIndexCount = (cells: number): number => cells * cells * 6 + 4 * cells * 6;

/**
 * Triangles of a tile mesh, the same for every tile, in eight drawing orders one after the other
 * (each `tileIndexCount` long, see `tileOrder`). Far from the camera the depth buffer can no
 * longer tell a ridge from the valley behind it, so there a tile is drawn back to front: the
 * cells row by row away from the far side, whichever side of the tile that is. Every order
 * starts with the skirt, which is behind everything else of the tile.
 *
 * A cell is cut along the diagonal from its (i+1, j) corner to its (i, j+1) corner, which
 * `bakeTile` relies on. Counter-clockwise seen from outside the body; the skirt faces away from
 * the tile.
 */
export function tileIndices(cells: number): Uint16Array {
  const row = cells + 1;
  const per = tileIndexCount(cells);
  const out = new Uint16Array(per * 8);
  let n = 0;
  for (let order = 0; order < 8; order++) {
    const first = row * row;
    for (let side = 0; side < 4; side++) {
      for (let i = 0; i < cells; i++) {
        const k = side * row + i;
        const b0 = skirtAnchor(k, cells);
        const b1 = skirtAnchor(k + 1, cells);
        out[n++] = b0; out[n++] = b1; out[n++] = first + k;
        out[n++] = b1; out[n++] = first + k + 1; out[n++] = first + k;
      }
    }
    // Bit 0: the outer loop runs over i instead of j. Bit 1: the outer loop counts down. Bit 2: the inner one does.
    const outerI = (order & 1) === 1;
    const outerDown = (order & 2) === 2;
    const innerDown = (order & 4) === 4;
    for (let a = 0; a < cells; a++) {
      for (let b = 0; b < cells; b++) {
        const outer = outerDown ? cells - 1 - a : a;
        const inner = innerDown ? cells - 1 - b : b;
        const i = outerI ? outer : inner;
        const j = outerI ? inner : outer;
        const v0 = j * row + i;
        const v1 = v0 + 1;
        const v2 = v0 + row;
        out[n++] = v0; out[n++] = v2; out[n++] = v1;
        out[n++] = v1; out[n++] = v2; out[n++] = v2 + 1;
      }
    }
  }
  return out;
}

/**
 * Which of the drawing orders of `tileIndices` draws a tile back to front (or, with `nearFirst`,
 * front to back) for a camera at `x`, `z` in the tile's own frame: along the axis the camera is
 * farther out on, starting at the side away from it.
 */
export function tileOrder(x: number, z: number, nearFirst: boolean): number {
  // Vertex columns run along +X of the tile frame and rows along +Z.
  const outerI = Math.abs(x) > Math.abs(z);
  const iDown = x < 0 !== nearFirst;
  const jDown = z < 0 !== nearFirst;
  return (outerI ? 1 : 0) | ((outerI ? iDown : jDown) ? 2 : 0) | ((outerI ? jDown : iDown) ? 4 : 0);
}

/** Per vertex its place in the tile, 0..1 along u and v; the same for every tile. */
export function tileUvs(cells: number): Float32Array {
  const row = cells + 1;
  const out = new Float32Array(tileVertexCount(cells) * 2);
  for (let j = 0; j <= cells; j++) {
    for (let i = 0; i <= cells; i++) {
      out[(j * row + i) * 2] = i / cells;
      out[(j * row + i) * 2 + 1] = j / cells;
    }
  }
  for (let k = 0; k < 4 * row; k++) {
    const a = skirtAnchor(k, cells);
    out[(row * row + k) * 2] = out[a * 2]!;
    out[(row * row + k) * 2 + 1] = out[a * 2 + 1]!;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Half floats
// ---------------------------------------------------------------------------------------------

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/** The bits of the 16-bit float nearest to `v`. */
export function toHalf(v: number): number {
  F32[0] = v;
  const x = U32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  const mant = x & 0x007fffff;
  if (exp < 103) return sign;
  if (exp > 142) return sign | 0x7c00;
  if (exp < 113) {
    const m = mant | 0x00800000;
    const shift = 126 - exp;
    return sign | ((m >> shift) + ((m >> (shift - 1)) & 1));
  }
  // A carry out of the mantissa rounds up into the exponent, which is what it should do.
  return sign | ((((exp - 112) << 10) | (mant >> 13)) + ((mant >> 12) & 1));
}

/** The value of the 16-bit float with these bits (for tests and for reading a baked map back). */
export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

// ---------------------------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------------------------

/** Buffers of the sample grid, kept between jobs of the same size so a bake allocates only what it returns. */
interface Scratch {
  /** Points per edge of the padded grid. */
  w: number;
  /** Unit directions, positions relative to the tile origin (body-fixed axes, metres), heights, tones. */
  dir: Float64Array;
  pos: Float64Array;
  h: Float64Array;
  tone: Float32Array;
  ta: Float64Array;
  tb: Float64Array;
}

const scratch = new Map<number, Scratch>();

function scratchFor(w: number): Scratch {
  let s = scratch.get(w);
  if (!s) {
    s = {
      w, dir: new Float64Array(w * w * 3), pos: new Float64Array(w * w * 3), h: new Float64Array(w * w),
      tone: new Float32Array(w * w), ta: new Float64Array(w), tb: new Float64Array(w),
    };
    scratch.set(w, s);
  }
  return s;
}

const SAMPLE = new Float64Array(2);
const FRAME = new Float64Array(12);

/** Bakes one tile. Pure: the same arguments give the same arrays. */
export function bakeTile(p: TerrainParams, spec: TileSpec): TileBake {
  const { face, level, ix, iy, cells, texels } = spec;
  const radius = p.radius;
  const g = cells * texels;
  const w = g + 3;
  const s = scratchFor(w);
  const detail = gridDetail(radius, level, cells, texels);

  tileFrame(face, level, ix, iy, radius, FRAME);
  const ox = FRAME[0]!, oy = FRAME[1]!, oz = FRAME[2]!;
  const xx = FRAME[3]!, xy = FRAME[4]!, xz = FRAME[5]!;
  const yx = FRAME[6]!, yy = FRAME[7]!, yz = FRAME[8]!;
  const zx = FRAME[9]!, zy = FRAME[10]!, zz = FRAME[11]!;

  // The grid, one ring wider than the tile.
  const span = tileSpan(level);
  const u0 = -1 + ix * span;
  const v0 = -1 + iy * span;
  for (let i = 0; i < w; i++) {
    s.ta[i] = faceTangent(u0 + ((i - 1) / g) * span);
    s.tb[i] = faceTangent(v0 + ((i - 1) / g) * span);
  }
  const { dir, pos, h, tone } = s;
  for (let j = 0; j < w; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const k3 = k * 3;
      facePoint(face, s.ta[i]!, s.tb[j]!, dir, k3);
      const dx = dir[k3]!, dy = dir[k3 + 1]!, dz = dir[k3 + 2]!;
      terrainSample(p, dx, dy, dz, detail, SAMPLE);
      const r = radius + SAMPLE[0]!;
      h[k] = SAMPLE[0]!;
      tone[k] = SAMPLE[1]!;
      pos[k3] = dx * r - ox;
      pos[k3 + 1] = dy * r - oy;
      pos[k3 + 2] = dz * r - oz;
    }
  }

  // The map: the normal at every grid point from its four neighbours, turned into the tile frame.
  const mapSize = g + 1;
  const map = new Uint16Array(mapSize * mapSize * 4);
  const one = toHalf(1);
  for (let j = 0; j < mapSize; j++) {
    for (let i = 0; i < mapSize; i++) {
      const k = (j + 1) * w + (i + 1);
      const e = (k + 1) * 3, f = (k - 1) * 3, n = (k + w) * 3, m = (k - w) * 3;
      const ux = pos[e]! - pos[f]!, uy = pos[e + 1]! - pos[f + 1]!, uz = pos[e + 2]! - pos[f + 2]!;
      const vx = pos[n]! - pos[m]!, vy = pos[n + 1]! - pos[m + 1]!, vz = pos[n + 2]! - pos[m + 2]!;
      // v x u points outward: the axes of a cube map face are a left-handed pair.
      const nx = vy * uz - vz * uy;
      const ny = vz * ux - vx * uz;
      const nz = vx * uy - vy * ux;
      const l = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      let lx = (nx * xx + ny * xy + nz * xz) * l;
      const ly = (nx * yx + ny * yy + nz * yz) * l;
      let lz = (nx * zx + ny * zy + nz * zz) * l;
      // The map stores x and z and the shader rebuilds y as positive. A slope that leans past
      // the tile's horizon (only at the corners of the largest tiles) is laid back onto it.
      if (ly < 0.05) {
        const scale = Math.sqrt(0.9975 / Math.max(lx * lx + lz * lz, 1e-12));
        lx *= scale;
        lz *= scale;
      }
      const o = (j * mapSize + i) * 4;
      map[o] = toHalf(lx);
      map[o + 1] = toHalf(lz);
      map[o + 2] = toHalf(tone[k]!);
      map[o + 3] = one;
    }
  }

  // The mesh: every `texels`-th grid point.
  const row = cells + 1;
  const count = tileVertexCount(cells);
  const positions = new Float32Array(count * 3);
  const coarse = new Float32Array(count * 3);
  const heights = new Float32Array(count * 2);
  let minH = Infinity;
  let maxH = -Infinity;
  for (let j = 0; j < row; j++) {
    for (let i = 0; i < row; i++) {
      const k = (j * texels + 1) * w + (i * texels + 1);
      const k3 = k * 3;
      const px = pos[k3]!, py = pos[k3 + 1]!, pz = pos[k3 + 2]!;
      const o = (j * row + i) * 3;
      positions[o] = px * xx + py * xy + pz * xz;
      positions[o + 1] = px * yx + py * yy + pz * yz;
      positions[o + 2] = px * zx + py * zy + pz * zz;
      const hv = h[k]!;
      heights[(j * row + i) * 2] = hv;
      if (hv < minH) minH = hv;
      if (hv > maxH) maxH = hv;
    }
  }

  // Where every vertex lies on the parent's surface. The parent has a vertex at every second
  // vertex of this tile, sampled at the parent's detail; between them its surface is its mesh:
  // straight along an edge, and along the diagonal the cells are cut on.
  if (level === 0) {
    coarse.set(positions.subarray(0, row * row * 3));
    for (let k = 0; k < row * row; k++) heights[k * 2 + 1] = heights[k * 2]!;
  } else {
    const same = spec.parentDetail === detail;
    for (let j = 0; j < row; j += 2) {
      for (let i = 0; i < row; i += 2) {
        const k = (j * texels + 1) * w + (i * texels + 1);
        const k3 = k * 3;
        const o = (j * row + i) * 3;
        if (same) {
          coarse[o] = positions[o]!;
          coarse[o + 1] = positions[o + 1]!;
          coarse[o + 2] = positions[o + 2]!;
          heights[(j * row + i) * 2 + 1] = h[k]!;
          continue;
        }
        const dx = dir[k3]!, dy = dir[k3 + 1]!, dz = dir[k3 + 2]!;
        terrainSample(p, dx, dy, dz, spec.parentDetail, SAMPLE);
        const r = radius + SAMPLE[0]!;
        const px = dx * r - ox, py = dy * r - oy, pz = dz * r - oz;
        coarse[o] = px * xx + py * xy + pz * xz;
        coarse[o + 1] = px * yx + py * yy + pz * yz;
        coarse[o + 2] = px * zx + py * zy + pz * zz;
        heights[(j * row + i) * 2 + 1] = SAMPLE[0]!;
      }
    }
    for (let j = 0; j < row; j++) {
      for (let i = 0; i < row; i++) {
        const oddI = (i & 1) === 1;
        const oddJ = (j & 1) === 1;
        if (!oddI && !oddJ) continue;
        // The two parent vertices this one lies halfway between.
        const a = oddI && oddJ ? (j - 1) * row + (i + 1) : oddI ? j * row + (i - 1) : (j - 1) * row + i;
        const b = oddI && oddJ ? (j + 1) * row + (i - 1) : oddI ? j * row + (i + 1) : (j + 1) * row + i;
        const o = (j * row + i) * 3;
        coarse[o] = 0.5 * (coarse[a * 3]! + coarse[b * 3]!);
        coarse[o + 1] = 0.5 * (coarse[a * 3 + 1]! + coarse[b * 3 + 1]!);
        coarse[o + 2] = 0.5 * (coarse[a * 3 + 2]! + coarse[b * 3 + 2]!);
        heights[(j * row + i) * 2 + 1] = 0.5 * (heights[a * 2 + 1]! + heights[b * 2 + 1]!);
      }
    }
  }

  const box = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let k = 0; k < row * row; k++) {
    for (let c = 0; c < 3; c++) {
      const a = positions[k * 3 + c]!;
      const b = coarse[k * 3 + c]!;
      box[c] = Math.min(box[c]!, a, b);
      box[c + 3] = Math.max(box[c + 3]!, a, b);
    }
  }

  // The skirt: every edge vertex again, lowered along its own vertical.
  const depth = skirtDepth(radius, level, cells);
  for (let n = 0; n < 4 * row; n++) {
    const a = skirtAnchor(n, cells);
    const aj = Math.floor(a / row);
    const ai = a - aj * row;
    const k3 = ((aj * texels + 1) * w + (ai * texels + 1)) * 3;
    const dx = dir[k3]!, dy = dir[k3 + 1]!, dz = dir[k3 + 2]!;
    const lx = (dx * xx + dy * xy + dz * xz) * depth;
    const ly = (dx * yx + dy * yy + dz * yz) * depth;
    const lz = (dx * zx + dy * zy + dz * zz) * depth;
    const o = (row * row + n) * 3;
    positions[o] = positions[a * 3]! - lx;
    positions[o + 1] = positions[a * 3 + 1]! - ly;
    positions[o + 2] = positions[a * 3 + 2]! - lz;
    coarse[o] = coarse[a * 3]! - lx;
    coarse[o + 1] = coarse[a * 3 + 1]! - ly;
    coarse[o + 2] = coarse[a * 3 + 2]! - lz;
    heights[(row * row + n) * 2] = heights[a * 2]!;
    heights[(row * row + n) * 2 + 1] = heights[a * 2 + 1]!;
  }

  return { positions, coarse, heights, map, mapSize, frame: Float64Array.from(FRAME), minH, maxH, box };
}

// ---------------------------------------------------------------------------------------------
// The far map
// ---------------------------------------------------------------------------------------------

/**
 * Rows `row0` to `row0 + rows` of one face of a body's far map, `size` texels wide: per texel
 * four half floats, the first three the ground normal as its slope vector in body-fixed axes
 * (`normal / dot(normal, direction) - direction`, so a shader gets the normal back as
 * `normalize(direction + slope)`), the fourth the tone. Texel centres are the cube map's.
 */
export function bakeFarRows(p: TerrainParams, face: number, size: number, row0: number, rows: number): Uint16Array {
  const radius = p.radius;
  const detail = (2 * tileSize(radius, 0)) / size;
  const w = size + 2;
  const hgt = rows + 2;
  const pos = new Float64Array(w * hgt * 3);
  const dir = new Float64Array(w * hgt * 3);
  const tone = new Float32Array(w * hgt);
  const ta = new Float64Array(w);
  for (let i = 0; i < w; i++) ta[i] = faceTangent(-1 + ((i - 0.5) * 2) / size);
  for (let j = 0; j < hgt; j++) {
    const tb = faceTangent(-1 + ((row0 + j - 0.5) * 2) / size);
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const k3 = k * 3;
      facePoint(face, ta[i]!, tb, dir, k3);
      terrainSample(p, dir[k3]!, dir[k3 + 1]!, dir[k3 + 2]!, detail, SAMPLE);
      const r = radius + SAMPLE[0]!;
      tone[k] = SAMPLE[1]!;
      pos[k3] = dir[k3]! * r;
      pos[k3 + 1] = dir[k3 + 1]! * r;
      pos[k3 + 2] = dir[k3 + 2]! * r;
    }
  }
  const out = new Uint16Array(size * rows * 4);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < size; i++) {
      const k = (j + 1) * w + (i + 1);
      const e = (k + 1) * 3, f = (k - 1) * 3, n = (k + w) * 3, m = (k - w) * 3;
      const ux = pos[e]! - pos[f]!, uy = pos[e + 1]! - pos[f + 1]!, uz = pos[e + 2]! - pos[f + 2]!;
      const vx = pos[n]! - pos[m]!, vy = pos[n + 1]! - pos[m + 1]!, vz = pos[n + 2]! - pos[m + 2]!;
      const nx = vy * uz - vz * uy;
      const ny = vz * ux - vx * uz;
      const nz = vx * uy - vy * ux;
      const dx = dir[k * 3]!, dy = dir[k * 3 + 1]!, dz = dir[k * 3 + 2]!;
      // No slope steeper than about 80 degrees: it would not survive averaging into mip levels.
      const along = Math.max(nx * dx + ny * dy + nz * dz, 0.17 * Math.sqrt(nx * nx + ny * ny + nz * nz));
      const o = (j * size + i) * 4;
      out[o] = toHalf(nx / along - dx);
      out[o + 1] = toHalf(ny / along - dy);
      out[o + 2] = toHalf(nz / along - dz);
      out[o + 3] = toHalf(tone[k]!);
    }
  }
  return out;
}
