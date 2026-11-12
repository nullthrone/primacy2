/**
 * Terrain of landable bodies: a height above or below the mean radius for every direction, and a
 * tone for shading. The server collides ships with it and the client draws it, so both must get
 * the same number for the same input, bit for bit.
 *
 * That is why this file is restricted. It uses only the four basic operations, Math.sqrt,
 * Math.floor, Math.abs, Math.min, Math.max, Math.imul and bit operations on 32-bit integers: all of
 * these are exactly specified. Math.sin, cos, exp, pow, log and hypot, the `**` operator and random
 * numbers are not, and must not be used here (a test scans this file for them). Nothing in the
 * sampling path allocates.
 *
 * The height is evaluated on the 3D point `direction * radius`, in metres, in body-fixed axes, so
 * there are no seams and no poles. It is the sum of
 * - continents: broad highlands and plains,
 * - ridged mountains where a mask allows them,
 * - roughness: twelve octaves from 20 km down to 10 m,
 * - craters in size classes from 5 m to a tenth of the body radius,
 * - long ridges on ice bodies, dune fields on desert bodies,
 * then softly limited to guaranteed bounds, then flattened where a ground base has its pad.
 */
import type { Vec3 } from '../math.ts';
import type { BodyDef } from './types.ts';

/** A solid body without atmosphere of class rocky, ice or desert: ships can land on it. */
export function isLandable(body: Pick<BodyDef, 'kind' | 'cls' | 'atmo'>): boolean {
  if (body.kind === 'star' || body.atmo) return false;
  return body.cls === 'rocky' || body.cls === 'ice' || body.cls === 'desert';
}

/** A flattened disc for a ground base. */
export interface TerrainPad {
  /** Unit direction of the pad centre in body-fixed axes. */
  dir: Readonly<Vec3>;
  /** Radius of the flat part, metres. */
  radius: number;
  /** Width of the ring in which the pad blends into the natural terrain, metres. */
  blend: number;
}

/** Constants of a body's terrain, built once by `terrainParams`. Treat as opaque and immutable. */
export interface TerrainParams {
  /** Mean radius of the body, metres. */
  readonly radius: number;
  /** 0 rocky, 1 ice, 2 desert. */
  readonly kind: number;
  /** Guaranteed bounds of the height, metres (see `terrainMin`, `terrainMax`). */
  readonly minHeight: number;
  readonly maxHeight: number;
  /** Heights beyond the knees are compressed toward the bounds. */
  readonly kneeLo: number;
  readonly kneeHi: number;

  /** Continents: wavelength (m), weight and lattice seed per octave; `contAmp` is their height in metres. */
  readonly contAmp: number;
  readonly contLambda: Float64Array;
  readonly contWeight: Float64Array;
  readonly contSeed: Int32Array;

  /** Mountains: mask wavelength and seed, ridged octaves, height in metres (0 = none). */
  readonly mtnAmp: number;
  readonly mtnMaskLambda: number;
  readonly mtnMaskSeed: number;
  readonly mtnLambda: Float64Array;
  readonly mtnWeight: Float64Array;
  readonly mtnSeed: Int32Array;

  /** Roughness octaves: wavelength and amplitude in metres (before the local factor). */
  readonly roughLambda: Float64Array;
  readonly roughAmp: Float64Array;
  readonly roughSeed: Int32Array;

  /** Crater classes: lattice cell size (m), deepest bowl and highest rim of the class (m), seed. */
  readonly craterCell: Float64Array;
  readonly craterDepth: Float64Array;
  readonly craterRim: Float64Array;
  readonly craterSeed: Int32Array;
  /** A lattice cell holds a crater when the low 16 bits of its hash are below this. */
  readonly craterDensity: number;
  /** Factor on the depth of every crater (worn craters on desert bodies, relaxed ones on ice). */
  readonly craterWear: number;
  /** Diameter (m) above which craters are shallower than a bowl and have a flat floor. */
  readonly craterFlat: number;

  /** Linear features (ice ridges, dunes): height in metres (0 = none), spacing, length, seeds and the two directions. */
  readonly lineAmp: number;
  readonly lineShort: number;
  readonly lineLong: number;
  readonly lineSeed: number;
  readonly lineMaskLambda: number;
  readonly lineMaskSeed: number;
  readonly lineDir: Float64Array;

  readonly pads: readonly PadParams[];
}

/** A pad with everything the sampler needs precomputed. */
interface PadParams {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Squared chord lengths on the unit sphere of the flat part and of the outer edge of the blend ring. */
  readonly inner2: number;
  readonly outer2: number;
  /** Flat radius and blend width as chord lengths on the unit sphere. */
  readonly inner: number;
  readonly width: number;
  /** Height of the flat part, metres: the natural height at the pad centre. */
  readonly height: number;
}

const ROCKY = 0;
const ICE = 1;
const DESERT = 2;

/** Roughness octaves run from this wavelength down to `ROUGH_TOP / 2^11` = 10 m. */
const ROUGH_TOP = 20_480;
const ROUGH_OCTAVES = 12;
/** Amplitude of a roughness octave as a fraction of its wavelength, on a rocky body. */
const ROUGH_SLOPE = 0.0105;
/** Largest value of the local roughness factor (mountains in highlands). */
const ROUGH_FACTOR_MAX = 2.4;

/** Cell size of the smallest crater class, metres. Each further class doubles it. */
const CRATER_CELL_MIN = 32;
/** The largest crater cell is at most this fraction of the body radius. */
const CRATER_CELL_MAX_RADII = 0.2;
/**
 * Geometry of a crater inside its lattice cell of size s. The centre lies within SHELL * s of the
 * mean sphere and the crater ends at most OUTER_MAX * s from it, measured along the ground. Then
 * the 3D distance from any point the crater touches to its centre is below s / 2 (0.4^2 + 0.268^2
 * < 0.25, the 0.268 being SHELL plus the curvature of the sphere over the crater), so the crater
 * is always among the 2 x 2 x 2 cells nearest to the point and never appears or vanishes abruptly.
 */
const CRATER_SHELL = 0.25;
const CRATER_OUTER_MIN = 0.2;
const CRATER_OUTER_MAX = 0.4;
/** Rim radius as a fraction of the outer radius: between these. The ejecta end at EJECTA rim radii. */
const CRATER_RIM_MIN = 0.34;
const CRATER_RIM_MAX = 0.62;
const CRATER_EJECTA = 1.6;
/** Depth of a fresh bowl crater as a fraction of its diameter, and rim height as a fraction of depth. */
const CRATER_DEPTH = 0.2;
const CRATER_RIM_HEIGHT = 0.2;
/** Craters keep at least this fraction of their fresh depth; most are near it, few are fresh. */
const CRATER_WORN = 0.18;

const KX = 0x27d4eb2f;
const KY = 0x165667b1;
const KZ = 0x9e3779b1;

/** The twelve edge directions of a cube (four repeated), as in Perlin's improved noise. */
const GX = new Float64Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0, 1, 0, -1, 0]);
const GY = new Float64Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1]);
const GZ = new Float64Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1, 0, 1, 0, -1]);

/** Scrambles a 32-bit integer (any exact integer below 2^53 is taken modulo 2^32). */
function mix(h: number): number {
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return h ^ (h >>> 15);
}

/** Dot product of the lattice gradient chosen by hash `h` with (x, y, z). */
function grad(h: number, x: number, y: number, z: number): number {
  const g = h >>> 28;
  return GX[g]! * x + GY[g]! * y + GZ[g]! * z;
}

/**
 * Gradient lattice noise in -1..1 with one feature per unit of the coordinates. The same input
 * gives the same bits on every machine.
 */
function noise3(x: number, y: number, z: number, seed: number): number {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);
  const x0 = x - fx;
  const y0 = y - fy;
  const z0 = z - fz;
  const x1 = x0 - 1;
  const y1 = y0 - 1;
  const z1 = z0 - 1;
  // Hash terms of the low corner; adding K moves one lattice step (the sums stay exact integers).
  const ax = Math.imul(fx | 0, KX) + seed;
  const ay = Math.imul(fy | 0, KY);
  const az = Math.imul(fz | 0, KZ);
  const bx = ax + KX;
  const by = ay + KY;
  const bz = az + KZ;
  const u = x0 * x0 * x0 * (x0 * (x0 * 6 - 15) + 10);
  const v = y0 * y0 * y0 * (y0 * (y0 * 6 - 15) + 10);
  const w = z0 * z0 * z0 * (z0 * (z0 * 6 - 15) + 10);

  const n000 = grad(mix(ax + ay + az), x0, y0, z0);
  const n100 = grad(mix(bx + ay + az), x1, y0, z0);
  const n010 = grad(mix(ax + by + az), x0, y1, z0);
  const n110 = grad(mix(bx + by + az), x1, y1, z0);
  const n001 = grad(mix(ax + ay + bz), x0, y0, z1);
  const n101 = grad(mix(bx + ay + bz), x1, y0, z1);
  const n011 = grad(mix(ax + by + bz), x0, y1, z1);
  const n111 = grad(mix(bx + by + bz), x1, y1, z1);

  const a0 = n000 + (n100 - n000) * u;
  const a1 = n010 + (n110 - n010) * u;
  const b0 = n001 + (n101 - n001) * u;
  const b1 = n011 + (n111 - n011) * u;
  const c0 = a0 + (a1 - a0) * v;
  const c1 = b0 + (b1 - b0) * v;
  const n = c0 + (c1 - c0) * w;
  return n < -1 ? -1 : n > 1 ? 1 : n;
}

/** 0 below `lo`, 1 above `hi`, a smooth step between. */
function smooth(lo: number, hi: number, x: number): number {
  if (x <= lo) return 0;
  if (x >= hi) return 1;
  const t = (x - lo) / (hi - lo);
  return t * t * (3 - 2 * t);
}

/** A float in 0..1 from 16 bits of a hash. */
const unit16 = (bits: number): number => (bits & 0xffff) / 65536;

/** Depth (m) of a fresh crater of diameter `d`; `flat` is the diameter where bowls end. */
function freshDepth(d: number, flat: number): number {
  // Larger craters collapse: their depth grows only with the fourth root of the diameter.
  return d < flat ? CRATER_DEPTH * d : CRATER_DEPTH * flat * Math.sqrt(Math.sqrt(d / flat));
}

/** A unit vector from a hash. Uses only square roots, so it is the same everywhere. */
function unitFromHash(h: number, out: Float64Array, at: number): void {
  let x = unit16(h) * 2 - 1;
  let y = unit16(h >>> 16) * 2 - 1;
  let z = unit16(mix(h + 0x51ed270b)) * 2 - 1;
  let l = Math.sqrt(x * x + y * y + z * z);
  if (!(l > 1e-3)) {
    x = 1;
    y = 0;
    z = 0;
    l = 1;
  }
  out[at] = x / l;
  out[at + 1] = y / l;
  out[at + 2] = z / l;
}

/**
 * Precomputes the terrain constants of a landable body from its seed, class and radius.
 * `pads` are the flattened discs of its ground bases.
 */
export function terrainParams(body: Pick<BodyDef, 'seed' | 'cls' | 'radius'>, pads: readonly TerrainPad[] = []): TerrainParams {
  const radius = body.radius;
  const kind = body.cls === 'ice' ? ICE : body.cls === 'desert' ? DESERT : ROCKY;
  const seed = mix((body.seed | 0) + 0x3c6ef372);
  const sub = (i: number): number => mix(seed + Math.imul(i, 0x632be5ab));
  /** A float in 0..1 that differs per body and purpose. */
  const vary = (i: number): number => unit16(sub(i) >>> 8);

  // Relief is true to scale: about two kilometres on a 1,000 km moon, less on small bodies
  // and no more than three on large ones.
  const scale = Math.min(3000, Math.max(1000, 0.002 * radius)) * (kind === ICE ? 0.45 : kind === DESERT ? 0.75 : 1);
  const contAmp = scale * (0.8 + 0.4 * vary(1));

  // Continents: five octaves from 0.9 radii down.
  const contLambda = new Float64Array(5);
  const contWeight = new Float64Array(5);
  const contSeed = new Int32Array(5);
  let lambda = 0.9 * radius;
  let weight = 1;
  let total = 0;
  for (let i = 0; i < 5; i++) {
    contLambda[i] = lambda;
    contWeight[i] = weight;
    contSeed[i] = sub(10 + i);
    total += weight;
    lambda *= 0.5;
    weight *= 0.5;
  }
  for (let i = 0; i < 5; i++) contWeight[i] = contWeight[i]! / total;

  // Mountains: ridged octaves from about 6 % of the radius (30 to 120 km) down to a few kilometres.
  const mtnAmp = kind === ICE ? 0 : scale * (kind === DESERT ? 0.7 : 1.2) * (0.8 + 0.4 * vary(2));
  const mtnLambda = new Float64Array(6);
  const mtnWeight = new Float64Array(6);
  const mtnSeed = new Int32Array(6);
  lambda = Math.min(120_000, Math.max(30_000, 0.06 * radius));
  weight = 1;
  total = 0;
  for (let i = 0; i < 6; i++) {
    mtnLambda[i] = lambda;
    mtnWeight[i] = weight;
    mtnSeed[i] = sub(20 + i);
    total += weight;
    lambda *= 0.5;
    weight *= 0.5;
  }
  for (let i = 0; i < 6; i++) mtnWeight[i] = mtnWeight[i]! / total;

  // Roughness: every octave has the same slope, so the ground is as rough at 10 m as at 10 km.
  const roughSlope = ROUGH_SLOPE * (kind === ICE ? 0.5 : kind === DESERT ? 0.6 : 1);
  const roughLambda = new Float64Array(ROUGH_OCTAVES);
  const roughAmp = new Float64Array(ROUGH_OCTAVES);
  const roughSeed = new Int32Array(ROUGH_OCTAVES);
  lambda = ROUGH_TOP;
  for (let i = 0; i < ROUGH_OCTAVES; i++) {
    roughLambda[i] = lambda;
    roughAmp[i] = roughSlope * lambda;
    roughSeed[i] = sub(30 + i);
    lambda *= 0.5;
  }

  // Craters: one class per doubling of the cell size, up to a fifth of the radius.
  const craterFlat = 12_000;
  let classes = 0;
  for (let s = CRATER_CELL_MIN; s <= CRATER_CELL_MAX_RADII * radius && classes < 24; s *= 2) classes++;
  const craterCell = new Float64Array(classes);
  const craterDepth = new Float64Array(classes);
  const craterRim = new Float64Array(classes);
  const craterSeed = new Int32Array(classes);
  const craterWear = kind === ICE ? 0.6 : kind === DESERT ? 0.5 : 1;
  let cell = CRATER_CELL_MIN;
  for (let i = 0; i < classes; i++) {
    craterCell[i] = cell;
    const deepest = freshDepth(2 * CRATER_OUTER_MAX * CRATER_RIM_MAX * cell, craterFlat) * craterWear;
    craterDepth[i] = deepest;
    craterRim[i] = deepest * CRATER_RIM_HEIGHT;
    craterSeed[i] = sub(50 + i);
    cell *= 2;
  }
  // Rocky bodies are saturated, ice is young and smooth, deserts keep the larger part.
  const craterDensity = Math.floor(65536 * (kind === ICE ? 0.2 : kind === DESERT ? 0.45 : 0.9));

  // Long ridges on ice, dunes on desert.
  const lineAmp = kind === ICE ? 60 + 40 * vary(3) : kind === DESERT ? 10 + 6 * vary(3) : 0;
  const lineShort = kind === ICE ? 4000 : 320;
  const lineLong = kind === ICE ? 64_000 : 2560;
  const lineDir = new Float64Array(6);
  unitFromHash(sub(40), lineDir, 0);
  unitFromHash(sub(41), lineDir, 3);

  // Bounds. The sum of every part could in theory reach further than any real terrain does,
  // so heights beyond the knees are compressed and never pass these limits.
  const maxHeight = contAmp + mtnAmp + 400;
  const minHeight = -(0.5 * contAmp + (classes > 0 ? craterDepth[classes - 1]! : 0) + 400);

  const base: TerrainParams = {
    radius, kind, minHeight, maxHeight, kneeLo: 0.75 * minHeight, kneeHi: 0.75 * maxHeight,
    contAmp, contLambda, contWeight, contSeed,
    mtnAmp, mtnMaskLambda: 0.3 * radius, mtnMaskSeed: sub(4), mtnLambda, mtnWeight, mtnSeed,
    roughLambda, roughAmp, roughSeed,
    craterCell, craterDepth, craterRim, craterSeed, craterDensity, craterWear, craterFlat,
    lineAmp, lineShort, lineLong, lineSeed: sub(5), lineMaskLambda: 0.15 * radius, lineMaskSeed: sub(6), lineDir,
    pads: [],
  };
  if (pads.length === 0) return base;

  const built: PadParams[] = [];
  for (const pad of pads) {
    const inner = Math.max(0, pad.radius) / radius;
    const width = Math.max(1, pad.blend) / radius;
    // The pad sits at the height the untouched ground has at its centre.
    sample(base, pad.dir[0], pad.dir[1], pad.dir[2], 0);
    built.push({
      x: pad.dir[0], y: pad.dir[1], z: pad.dir[2],
      inner, width, inner2: inner * inner, outer2: (inner + width) * (inner + width), height: outH,
    });
  }
  return { ...base, pads: built };
}

/** Lowest height (m, negative) the terrain of these parameters can have. */
export const terrainMin = (p: TerrainParams): number => p.minHeight;
/** Highest height (m) the terrain of these parameters can have. */
export const terrainMax = (p: TerrainParams): number => p.maxHeight;

/**
 * The most (m) by which the height at `detail` can differ from the full height: the summed
 * amplitude of every octave and crater class that `detail` skips.
 */
export function terrainSkipped(p: TerrainParams, detail: number): number {
  if (!(detail > 0)) return 0;
  // The continents and the mountain mask steer everything else, so without them nothing is certain.
  if (p.contLambda[p.contLambda.length - 1]! < detail || (p.mtnAmp > 0 && p.mtnMaskLambda < detail)) return p.maxHeight - p.minHeight;
  let rough = 0;
  let roughAll = 0;
  for (let i = 0; i < p.roughLambda.length; i++) {
    roughAll += p.roughAmp[i]!;
    if (p.roughLambda[i]! < detail) rough += p.roughAmp[i]!;
  }
  let sum = rough * ROUGH_FACTOR_MAX;
  if (p.mtnAmp > 0) {
    // A skipped mountain octave also changes how rough the ground is and how much room dunes get.
    let weight = 0;
    for (let i = 0; i < p.mtnLambda.length; i++) if (p.mtnLambda[i]! < detail) weight += p.mtnWeight[i]!;
    sum += weight * (p.mtnAmp + roughAll + p.lineAmp);
  }
  for (let i = 0; i < p.craterCell.length; i++) {
    if (craterClassSize(p.craterCell[i]!) < detail) sum += p.craterDepth[i]! + p.craterRim[i]!;
  }
  if (p.lineAmp > 0 && p.lineShort < detail) sum += p.lineAmp * (p.kind === ICE ? 2 : 1);
  return sum;
}

/** Diameter (m) of the largest crater of the class with cell size `cell`. */
const craterClassSize = (cell: number): number => 2 * CRATER_OUTER_MAX * CRATER_RIM_MAX * cell;

// Results of `sample`. Module-level so that sampling allocates nothing.
let outH = 0;
let outTone = 0;
// Results of `craters`.
let craterH = 0;
let craterTone = 0;

/**
 * Adds up the craters of every class at the point (px, py, pz) = direction * radius, whose unit
 * direction is (nx, ny, nz). `depthScale` scales every crater (plains are flooded and keep less).
 */
function craters(p: TerrainParams, px: number, py: number, pz: number, nx: number, ny: number, nz: number, detail: number, depthScale: number): void {
  let height = 0;
  let tone = 0;
  const r = p.radius;
  for (let c = p.craterCell.length - 1; c >= 0; c--) {
    const s = p.craterCell[c]!;
    if (craterClassSize(s) < detail) break;
    const seed = p.craterSeed[c]!;
    const inv = 1 / s;
    // The 2 x 2 x 2 cells nearest to the point.
    const cx = Math.floor(px * inv - 0.5);
    const cy = Math.floor(py * inv - 0.5);
    const cz = Math.floor(pz * inv - 0.5);
    const lo = r - CRATER_SHELL * s;
    const hi = r + CRATER_SHELL * s;
    const lo2 = lo * lo;
    const hi2 = hi * hi;
    const hx = Math.imul(cx | 0, KX) + seed;
    const hy = Math.imul(cy | 0, KY);
    const hz = Math.imul(cz | 0, KZ);
    let bowl = 0;
    let rim = 0;
    for (let k = 0; k < 8; k++) {
      const ix = k & 1;
      const iy = (k >> 1) & 1;
      const iz = k >> 2;
      const h = mix(hx + ix * KX + hy + iy * KY + hz + iz * KZ);
      if ((h & 0xffff) >= p.craterDensity) continue;
      const h1 = mix(h + 0x68bc21eb);
      const h2 = mix(h1 + 0x02e5be93);
      const ccx = (cx + ix + unit16(h1)) * s;
      const ccy = (cy + iy + unit16(h1 >>> 16)) * s;
      const ccz = (cz + iz + unit16(h2)) * s;
      // Only centres close to the surface make a crater.
      const c2 = ccx * ccx + ccy * ccy + ccz * ccz;
      if (c2 < lo2 || c2 > hi2) continue;
      const dx = px - ccx;
      const dy = py - ccy;
      const dz = pz - ccz;
      // Distance along the ground: the offset with its vertical part removed.
      const dn = dx * nx + dy * ny + dz * nz;
      const d2 = dx * dx + dy * dy + dz * dz - dn * dn;
      const outer = s * (CRATER_OUTER_MIN + (CRATER_OUTER_MAX - CRATER_OUTER_MIN) * unit16(h2 >>> 16));
      if (d2 >= outer * outer) continue;

      const h3 = mix(h2 + 0x7f4a7c15);
      const rimRadius = outer * (CRATER_RIM_MIN + (CRATER_RIM_MAX - CRATER_RIM_MIN) * unit16(h3));
      const dist = d2 > 0 ? Math.sqrt(d2) : 0;
      const x = dist / rimRadius;
      // Most craters are old and shallow: the depth left grows with the square of a uniform number.
      const age = unit16(h3 >>> 16);
      const fresh = CRATER_WORN + (1 - CRATER_WORN) * age * age;
      const diameter = 2 * rimRadius;
      const depth = freshDepth(diameter, p.craterFlat) * fresh * p.craterWear * depthScale;
      const lip = depth * CRATER_RIM_HEIGHT;
      let z: number;
      if (x < 1) {
        // Bowl, with a flat floor in craters too large to hold one.
        const floor = diameter < p.craterFlat ? 0 : 0.65 * (1 - p.craterFlat / diameter);
        const t = x <= floor ? 0 : (x - floor) / (1 - floor);
        z = -depth + (depth + lip) * t * t;
      } else if (x < CRATER_EJECTA) {
        const t = (CRATER_EJECTA - x) / (CRATER_EJECTA - 1);
        z = lip * t * t * t;
      } else {
        z = 0;
      }
      // Overlapping craters of one class merge instead of adding up.
      if (z < bowl) bowl = z;
      else if (z > rim) rim = z;

      // Fresh craters are bright inside and throw bright rays over their surroundings.
      if (age > 0.72 && p.kind !== DESERT) {
        const f = (age - 0.72) / 0.28;
        let bright: number;
        if (x < 1) {
          bright = 0.55 + 0.45 * x;
        } else {
          const reach = outer / rimRadius;
          const t = 1 - (x - 1) / (reach - 1);
          // An angular pattern from one component of the direction away from the centre.
          const g = h3 >>> 28;
          const a = dist > 0 ? ((dx - dn * nx) * GX[g]! + (dy - dn * ny) * GY[g]! + (dz - dn * nz) * GZ[g]!) / (dist * 1.4142135623730951) : 0;
          const a2 = a * a;
          const ray = 1 + a2 * (-32 + a2 * (160 + a2 * (-256 + a2 * 128)));
          bright = t * t * (0.3 + 0.7 * (ray > 0 ? ray * ray : 0));
        }
        const add = f * f * bright;
        if (add > tone) tone = add;
      }
    }
    height += bowl + rim;
  }
  craterH = height;
  craterTone = tone;
}

/**
 * Ridged noise stretched along `dir`: narrow crests `lineShort` apart and `lineLong` long.
 * Returns 0..1, 1 on the crest.
 */
function lines(p: TerrainParams, px: number, py: number, pz: number, at: number, seed: number): number {
  const wx = p.lineDir[at]!;
  const wy = p.lineDir[at + 1]!;
  const wz = p.lineDir[at + 2]!;
  const along = (px * wx + py * wy + pz * wz) * (1 / p.lineLong - 1 / p.lineShort);
  const inv = 1 / p.lineShort;
  const n = noise3(px * inv + wx * along + 7.31, py * inv + wy * along + 1.77, pz * inv + wz * along + 4.19, seed);
  return 1 - Math.abs(n);
}

/** Evaluates height and tone for the unit direction (x, y, z) into `outH` and `outTone`. */
function sample(p: TerrainParams, x: number, y: number, z: number, detail: number): void {
  // Pads first: inside the flat part nothing else matters.
  let padWeight = 0;
  let padHeight = 0;
  for (let i = 0; i < p.pads.length; i++) {
    const pad = p.pads[i]!;
    const dx = x - pad.x;
    const dy = y - pad.y;
    const dz = z - pad.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= pad.outer2) continue;
    if (d2 <= pad.inner2) {
      outH = pad.height;
      outTone = 0.5;
      return;
    }
    const t = (Math.sqrt(d2) - pad.inner) / pad.width;
    const w = 1 - t * t * t * (t * (t * 6 - 15) + 10);
    if (w > padWeight) {
      padWeight = w;
      padHeight = pad.height;
    }
  }

  const r = p.radius;
  const px = x * r;
  const py = y * r;
  const pz = z * r;

  // Continents.
  let cont = 0;
  for (let i = 0; i < p.contLambda.length; i++) {
    const lambda = p.contLambda[i]!;
    if (lambda < detail) break;
    const f = 1 / lambda;
    cont += p.contWeight[i]! * noise3(px * f + 0.5 + i * 0.37, py * f + 0.25 + i * 0.61, pz * f + 0.75 + i * 0.13, p.contSeed[i]!);
  }
  cont *= 2;
  if (cont > 1) cont = 1;
  else if (cont < -1) cont = -1;
  // 0 in the plains, 1 in the highlands.
  const high = smooth(-0.15, 0.3, cont);
  let h = p.contAmp * cont * (0.4 + 0.6 * high);

  // Mountains, only where the mask and the highlands allow them.
  let mtn = 0;
  if (p.mtnAmp > 0 && p.mtnMaskLambda >= detail) {
    const f = 1 / p.mtnMaskLambda;
    const mask = smooth(0.1, 0.5, 2 * noise3(px * f + 3.3, py * f + 8.1, pz * f + 5.7, p.mtnMaskSeed)) * high;
    if (mask > 0) {
      let ridge = 0;
      for (let i = 0; i < p.mtnLambda.length; i++) {
        const lambda = p.mtnLambda[i]!;
        if (lambda < detail) break;
        const g = 1 / lambda;
        const n = 1 - Math.abs(noise3(px * g + 0.5 + i * 0.29, py * g + 0.5 + i * 0.53, pz * g + 0.5 + i * 0.71, p.mtnSeed[i]!));
        ridge += p.mtnWeight[i]! * n * n;
      }
      mtn = mask * ridge;
      h += p.mtnAmp * mtn;
    }
  }

  // Roughness: gentle in the plains, strong in the mountains.
  const roughFactor = 0.6 + 0.8 * high + mtn;
  let rough = 0;
  let mottle = 0;
  for (let i = 0; i < p.roughLambda.length; i++) {
    const lambda = p.roughLambda[i]!;
    if (lambda < detail) break;
    const f = 1 / lambda;
    const n = noise3(px * f + 0.5 + i * 0.41, py * f + 0.5 + i * 0.17, pz * f + 0.5 + i * 0.83, p.roughSeed[i]!);
    rough += p.roughAmp[i]! * n;
    if (i === 1) mottle = n;
  }
  h += rough * roughFactor;

  // Craters, flooded and shallow in the plains.
  craters(p, px, py, pz, x, y, z, detail, 0.5 + 0.5 * high);
  h += craterH;

  // Tone: dark plains against bright highlands, with bright fresh craters.
  let tone: number;
  if (p.kind === ICE) {
    // Two sets of long ridges; dust gathers on them, so they are dark against the ice.
    let crest = 0;
    if (p.lineShort >= detail) {
      const a = lines(p, px, py, pz, 0, p.lineSeed);
      const b = lines(p, px, py, pz, 3, p.lineSeed ^ 0x5bd1e995);
      // The eighth power leaves narrow crests with smooth ice between them.
      const a2 = a * a;
      const b2 = b * b;
      const a4 = a2 * a2;
      const b4 = b2 * b2;
      const ra = a4 * a4;
      const rb = b4 * b4;
      h += p.lineAmp * (ra + rb);
      crest = ra > rb ? ra : rb;
    }
    tone = 0.74 + 0.14 * high + 0.06 * mottle - 0.4 * crest + 0.3 * craterTone;
  } else if (p.kind === DESERT) {
    // Dune fields where a broad mask allows them.
    let dune = 0;
    if (p.lineShort >= detail) {
      const f = 1 / p.lineMaskLambda;
      const mask = smooth(0.0, 0.35, 2 * noise3(px * f + 2.2, py * f + 6.6, pz * f + 9.9, p.lineMaskSeed)) * (1 - mtn);
      if (mask > 0) {
        const a = lines(p, px, py, pz, 0, p.lineSeed);
        dune = mask * a * a;
        h += p.lineAmp * dune;
      }
    }
    tone = 0.42 + 0.2 * high + 0.08 * mottle + 0.14 * dune - 0.1 * mtn;
  } else {
    tone = 0.2 + 0.4 * high + 0.07 * mottle + 0.08 * mtn + 0.45 * craterTone;
  }

  // Compress what lies beyond the knees so that the bounds hold whatever the parts add up to.
  if (h > p.kneeHi) {
    const span = p.maxHeight - p.kneeHi;
    const u = (h - p.kneeHi) / span;
    h = p.kneeHi + (span * u) / (1 + u);
  } else if (h < p.kneeLo) {
    const span = p.kneeLo - p.minHeight;
    const u = (p.kneeLo - h) / span;
    h = p.kneeLo - (span * u) / (1 + u);
  }

  if (padWeight > 0) {
    h += (padHeight - h) * padWeight;
    tone += (0.5 - tone) * padWeight;
  }
  outH = h;
  outTone = tone < 0 ? 0 : tone > 1 ? 1 : tone;
}

/**
 * Height in metres above (positive) or below the mean radius for the unit direction (x, y, z) in
 * body-fixed axes. `detail` is the smallest feature size in metres the caller needs: octaves and
 * craters below it are skipped, which makes a coarse mesh or a far bake cheaper. With `detail` 0
 * this is the full function, the one ships collide with.
 */
export function terrainHeight(p: TerrainParams, x: number, y: number, z: number, detail = 0): number {
  sample(p, x, y, z, detail);
  return outH;
}

/**
 * Like `terrainHeight`, and also gives the tone for shading from the same pass: writes the height
 * (m) into `out[0]` and the tone into `out[1]`. The tone is 0..1: dark plains against bright
 * highlands, bright fresh craters with rays, dark ridges on ice, pale dune crests.
 */
export function terrainSample(p: TerrainParams, x: number, y: number, z: number, detail: number, out: { [index: number]: number }): void {
  sample(p, x, y, z, detail);
  out[0] = outH;
  out[1] = outTone;
}

/**
 * Ground normal and slope at the unit direction (x, y, z), measured over `baseline` metres (the
 * footprint that matters: a ship, a base). Writes the outward unit normal in body-fixed axes into
 * `out` and returns the slope as rise over run (the tangent of the slope angle).
 */
export function terrainNormal(p: TerrainParams, x: number, y: number, z: number, baseline: number, out: Vec3, detail = 0): number {
  // Two unit vectors along the ground: the first is at right angles to the direction and to the
  // coordinate axis the direction is farthest from.
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  let e1x: number;
  let e1y: number;
  let e1z: number;
  if (ax <= ay && ax <= az) {
    e1x = 0; e1y = -z; e1z = y;
  } else if (ay <= az) {
    e1x = z; e1y = 0; e1z = -x;
  } else {
    e1x = -y; e1y = x; e1z = 0;
  }
  const l = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z);
  e1x /= l; e1y /= l; e1z /= l;
  const e2x = y * e1z - z * e1y;
  const e2y = z * e1x - x * e1z;
  const e2z = x * e1y - y * e1x;

  // Four points half a baseline away, brought back onto the unit sphere.
  const half = (0.5 * baseline) / p.radius;
  const k = 1 / Math.sqrt(1 + half * half);
  const g1 = (terrainHeight(p, (x + e1x * half) * k, (y + e1y * half) * k, (z + e1z * half) * k, detail)
    - terrainHeight(p, (x - e1x * half) * k, (y - e1y * half) * k, (z - e1z * half) * k, detail)) / baseline;
  const g2 = (terrainHeight(p, (x + e2x * half) * k, (y + e2y * half) * k, (z + e2z * half) * k, detail)
    - terrainHeight(p, (x - e2x * half) * k, (y - e2y * half) * k, (z - e2z * half) * k, detail)) / baseline;

  const nx = x - e1x * g1 - e2x * g2;
  const ny = y - e1y * g1 - e2y * g2;
  const nz = z - e1z * g1 - e2z * g2;
  const n = Math.sqrt(nx * nx + ny * ny + nz * nz);
  out[0] = nx / n;
  out[1] = ny / n;
  out[2] = nz / n;
  return Math.sqrt(g1 * g1 + g2 * g2);
}
