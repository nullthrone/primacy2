/**
 * Procedural sectors and star systems. Deterministic: the same parameters always produce the
 * same systems on every machine, and system `i` does not depend on how many systems are generated.
 *
 * Conventions introduced here (the types in `types.ts` leave them open):
 * - Spin axis: a body's rotation axis is +Y rotated about +X by `tilt`, i.e. (0, cos tilt, sin tilt)
 *   in system axes (see `bodySpinAxis`). Rings lie in the plane normal to it, and ring sites and
 *   moons orbit in that plane, which is the Kepler plane with `inc = tilt` and `node = 0`.
 * - `atmo.density` is the surface density relative to Earth's sea-level air (1 = 1.225 kg/m^3);
 *   `atmo.height` is the visible depth of the atmosphere in metres (about seven scale heights).
 * - `BodyDef.lum` of a black hole is the luminosity of its accretion disk, `temp` the colour
 *   temperature of that disk and `rotPeriod` the orbital period of the disk's outer rim.
 */
import {
  AU, C, CORE_REGION_RADIUS, DAY, DEFAULT_SITE_FRAME_RADIUS, EARTH_MASS, EARTH_RADIUS, FOLD_ARRIVAL_MIN,
  FOLD_ARRIVAL_RADII, G, JUPITER_MASS, JUPITER_RADIUS, MAX_SYSTEMS_PER_SECTOR, SITE_ID_BASE, SOLAR_LUMINOSITY,
  SOLAR_MASS, SOLAR_RADIUS, SOLAR_TEMP, SURFACE_ID_BASE, YEAR, BASE_MAX_GRAVITY, BASE_PAD_BLEND, BASE_PAD_RADIUS,
} from '../constants.ts';
import { clamp, v3, type Vec3 } from '../math.ts';
import { hashCombine, hashString, rngFor, type Rng } from '../prng.ts';
import { baseName, factionName, moonLetter, outpostName, romanNumeral, stationName, uniqueName, uniqueSystemName } from './names.ts';
import { bodySpinAxis, circularOrbit, orbitalPeriod, soiRadius } from './orbits.ts';
import { isLandable, terrainHeight, terrainParams, terrainRelief } from './terrain.ts';
import type {
  BeltDef, BeltKind, BodyDef, EconomyType, GateInfo, OrbitDef, PlanetClass, SectorParams, Security, SiteDef,
  StarClass, StationService, SystemDef, SystemSummary,
} from './types.ts';

// The spin axis convention lives with the rest of the rotation code in orbits.ts.
export { bodySpinAxis };

const TWO_PI = Math.PI * 2;
/** Stefan-Boltzmann constant, W m^-2 K^-4. */
const SIGMA = 5.670374419e-8;
/** Boltzmann constant, J/K. */
const K_B = 1.380649e-23;
/** Atomic mass unit, kg. */
const M_U = 1.66053907e-27;

/** Vertical squash of a sector: offsets fill an ellipsoid whose Y semi-axis is this fraction of the radius. */
export const SECTOR_FLATTENING = 0.35;
/** Minimum distance between two systems of a sector, light years. Relaxed only when a sector is too small. */
export const MIN_SYSTEM_SEPARATION_LY = 2;
/** Zone radius of belt and anomaly mining sites, metres. */
export const BELT_SITE_FRAME_RADIUS = 60_000;
/** Zone radius of ring mining sites, metres. */
export const RING_SITE_FRAME_RADIUS = 40_000;
/** Zone radius of navigation beacons, metres. */
export const BEACON_FRAME_RADIUS = 100_000;
/** Anomaly sites orbit where the pull of the compact object is below this, m/s^2. */
export const ANOMALY_MAX_GRAVITY = 2;

// ---------------------------------------------------------------------------------------------
// Sector layout
// ---------------------------------------------------------------------------------------------

/**
 * How remote a system counts as, 0 (heartland) to 1 (fringe). Depends only on (serverId, seed,
 * index), so a system knows it without knowing the sector layout; it drives security levels.
 * It is a property of the system, not its geometric distance from the sector centre.
 * System 0, the capital, is always below 0.12.
 */
export function systemEdgeFraction(serverId: string, seed: string, index: number): number {
  const u = rngFor(seed, serverId, 'edge', index).float();
  if (index === 0) return 0.12 * u;
  // Uniform in volume between the core shell (0.25) and the edge, so the core stays uncrowded.
  const core = 0.25 ** 3;
  return Math.cbrt(core + (1 - core) * u);
}

const isClear = (pos: Readonly<Vec3>, placed: readonly Vec3[], separation: number): boolean => {
  const sq = separation * separation;
  for (const p of placed) if (v3.distSq(pos, p) < sq) return false;
  return true;
};

/**
 * Longest distance (light years) between a system and its nearest lower-numbered neighbour.
 * It is below the jump range of the starter hull, so every system of a sector can be reached
 * from its capital without leaving the sector.
 */
export const MAX_NEIGHBOUR_HOP_LY = 6.5;

/**
 * Positions of the systems of a sector relative to its centre (light years), index-aligned with
 * system indices. Independent of where the sector is placed, so a server can generate offsets
 * first and choose its centre afterwards.
 *
 * The sector grows outward from the capital: system 0 lies near the centre and every later system
 * is placed within MAX_NEIGHBOUR_HOP_LY of an earlier one, at least MIN_SYSTEM_SEPARATION_LY from
 * all others. Offset i depends only on (serverId, seed, radius) and earlier indices, never on count.
 * The offsets stay inside an ellipsoid flattened along Y (`SECTOR_FLATTENING`), so |offset| <= radius.
 */
export function sectorOffsets(serverId: string, seed: string, radius: number, count: number): Vec3[] {
  const out: Vec3[] = [];
  const inside = (q: Readonly<Vec3>): boolean => Math.hypot(q[0], q[1] / SECTOR_FLATTENING, q[2]) <= radius;
  const hopMax = Math.min(MAX_NEIGHBOUR_HOP_LY, radius * 1.2);
  for (let i = 0; i < count; i++) {
    const rng = rngFor(seed, serverId, 'offset', i);
    if (i === 0) {
      const d = rng.unitVector();
      const r = 0.12 * radius * rng.float();
      out.push([d[0] * r, d[1] * r * SECTOR_FLATTENING, d[2] * r]);
      continue;
    }
    let separation = MIN_SYSTEM_SEPARATION_LY;
    let pos: Vec3 | null = null;
    // The separation is relaxed when a round finds no free spot, which happens only in sectors
    // too small for their system count.
    search: for (let round = 0; round < 48; round++) {
      for (let attempt = 0; attempt < 24; attempt++) {
        const base = out[rng.int(0, out.length - 1)]!;
        const d = rng.unitVector();
        const hop = rng.range(Math.min(separation, hopMax * 0.5), hopMax);
        const cand: Vec3 = [base[0] + d[0] * hop, base[1] + d[1] * hop * SECTOR_FLATTENING, base[2] + d[2] * hop];
        if (inside(cand) && isClear(cand, out, separation)) {
          pos = cand;
          break search;
        }
      }
      separation *= 0.8;
    }
    // Unreachable in practice; keeps the function total without ever stacking two systems.
    if (!pos) {
      const base = out[0]!;
      pos = [base[0] * 0.5 + 1e-3 * i, base[1] * 0.5, base[2] * 0.5 - 1e-3 * i];
    }
    out.push(pos);
  }
  return out;
}

export interface PlacementPeer {
  pos: Vec3;
  radius: number;
  systems: { pos: Vec3 }[];
}

export interface PlacementArgs {
  serverId: string;
  /** Own system offsets from `sectorOffsets`. */
  offsets: Vec3[];
  radius: number;
  /** The first reachable bootstrap peer, or null for a standalone server. */
  peer: PlacementPeer | null;
  /** Every other known sector; the new sector avoids overlapping their centres. */
  others: { pos: Vec3; radius: number }[];
  /** Jump range (ly) the closest pair of systems must be within. */
  reach: number;
}

/** A candidate centre overlaps another sector when their centres are closer than this fraction of the summed radii. */
const SECTOR_OVERLAP_FACTOR = 0.75;
/** Number of directions (or core spots) tried before settling for the least crowded one. */
const PLACEMENT_ATTEMPTS = 32;
/** The closest pair of systems is placed at this fraction of the jump range. */
const PLACEMENT_REACH_FRACTION = 0.7;

/** Centre beside the peer along the `attempt`-th direction derived from the server id. */
function centerBesidePeer(args: PlacementArgs, peer: PlacementPeer, attempt: number): Vec3 {
  const rng = rngFor(args.serverId, 'placement', attempt);
  const azimuth = rng.range(0, TWO_PI);
  // Sectors spread through the galactic disc, so the direction stays close to the XZ plane.
  const dir = v3.normalize([Math.cos(azimuth), rng.range(-0.15, 0.15), Math.sin(azimuth)]);
  const own: readonly Vec3[] = args.offsets.length > 0 ? args.offsets : [[0, 0, 0]];
  const theirs: readonly Vec3[] = peer.systems.length > 0 ? peer.systems.map((s) => s.pos) : [peer.pos];

  let ownExtent = 0;
  for (const o of own) ownExtent = Math.max(ownExtent, v3.len(o));
  let peerExtent = 0;
  for (const p of theirs) peerExtent = Math.max(peerExtent, v3.dist(p, peer.pos));

  const reach = Number.isFinite(args.reach) && args.reach > 0 ? args.reach : 1;
  const target = PLACEMENT_REACH_FRACTION * reach;
  const minStep = 0.002 * reach;
  /** Distance of the closest pair when the centre sits `s` light years from the peer centre. */
  const closest = (s: number): number => {
    let best = Infinity;
    for (const o of own) {
      const x = peer.pos[0] + dir[0] * s + o[0];
      const y = peer.pos[1] + dir[1] * s + o[1];
      const z = peer.pos[2] + dir[2] * s + o[2];
      for (const p of theirs) {
        const dx = x - p[0], dy = y - p[1], dz = z - p[2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best);
  };

  // Start where every pair is out of reach and walk inward. The pair distance changes by at most
  // one light year per light year travelled, so a step of (distance - target) never skips the
  // first point where the distance reaches the target.
  const start = ownExtent + peerExtent + reach;
  let s = start;
  let bestS = s;
  let bestDist = Infinity;
  for (let i = 0; i < 20_000 && s >= -start; i++) {
    const d = closest(s);
    if (d < bestDist) {
      bestDist = d;
      bestS = s;
    }
    if (d <= target + minStep) break;
    s -= Math.max(d - target, minStep);
  }
  // `bestS` is the accepted spot, or the closest approach when the line never comes within the target.
  return [peer.pos[0] + dir[0] * bestS, peer.pos[1] + dir[1] * bestS, peer.pos[2] + dir[2] * bestS];
}

/** The `attempt`-th standalone spot derived from the server id: inside the core region, flattened to a disc. */
function centerInCore(serverId: string, attempt: number): Vec3 {
  const rng = rngFor(serverId, 'core', attempt);
  const r = CORE_REGION_RADIUS * 0.94 * Math.sqrt(rng.float());
  const azimuth = rng.range(0, TWO_PI);
  return [r * Math.cos(azimuth), rng.range(-1, 1) * CORE_REGION_RADIUS * 0.05, r * Math.sin(azimuth)];
}

/**
 * Chooses a sector centre. With a peer, the sector is placed adjacent to it in a direction derived
 * from the server id, at the distance where the closest pair of systems (one of ours, one of the
 * peer's) is between 0.5 * reach and 0.9 * reach apart, trying further directions when the spot
 * overlaps another known sector. Without a peer, a position derived from the server id inside
 * the core region (CORE_REGION_RADIUS, flattened to a disc).
 *
 * An entry of `others` that sits on the peer's own centre is ignored, because the new sector is
 * meant to touch its peer. When every candidate overlaps some sector the least crowded one wins.
 */
export function chooseSectorCenter(args: PlacementArgs): Vec3 {
  const { peer, radius } = args;
  const others = peer ? args.others.filter((o) => v3.dist(o.pos, peer.pos) > 1e-6) : args.others;
  /** Smallest centre distance to another sector in units of the overlap distance; >= 1 means free. */
  const clearance = (c: Readonly<Vec3>): number => {
    let min = Infinity;
    for (const o of others) {
      const limit = SECTOR_OVERLAP_FACTOR * (radius + o.radius);
      min = Math.min(min, limit > 0 ? v3.dist(c, o.pos) / limit : Infinity);
    }
    return min;
  };

  let best: Vec3 = [0, 0, 0];
  let bestClearance = -1;
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
    const candidate = peer ? centerBesidePeer(args, peer, attempt) : centerInCore(args.serverId, attempt);
    const c = clearance(candidate);
    if (c >= 1) return candidate;
    if (c > bestClearance) {
      best = candidate;
      bestClearance = c;
    }
  }
  return best;
}

/** The closest pair between two sets of systems and their distance in light years. */
export function nearestPair<A extends { pos: Vec3 }, B extends { pos: Vec3 }>(
  a: readonly A[],
  b: readonly B[],
): { a: A; b: B; dist: number } | null {
  let best: { a: A; b: B; dist: number } | null = null;
  let bestSq = Infinity;
  for (const x of a) {
    for (const y of b) {
      const d = v3.distSq(x.pos, y.pos);
      if (d < bestSq) {
        bestSq = d;
        best = { a: x, b: y, dist: 0 };
      }
    }
  }
  if (best) best.dist = Math.sqrt(bestSq);
  return best;
}

// ---------------------------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------------------------

const rgb = (r: number, g: number, b: number): number =>
  (Math.round(clamp(r, 0, 255)) << 16) | (Math.round(clamp(g, 0, 255)) << 8) | Math.round(clamp(b, 0, 255));

/** Colour 0xRRGGBB of a black body at `tempK` kelvin (Tanner Helland's fit, valid 1000 K to 40000 K). */
function blackbodyColor(tempK: number): number {
  const t = clamp(tempK, 1000, 40_000) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * (t - 60) ** -0.1332047592;
    g = 288.1221695283 * (t - 60) ** -0.0755148492;
    b = 255;
  }
  return rgb(r, g, b);
}

/** Scales each channel of a colour by an independent random factor in [1 - amount, 1 + amount]. */
function jitterColor(rng: Rng, color: number, amount: number): number {
  const f = (): number => 1 + rng.range(-amount, amount);
  return rgb(((color >> 16) & 255) * f(), ((color >> 8) & 255) * f(), (color & 255) * f());
}

/** Blends a colour toward white by `t` in 0..1. */
function lighten(color: number, t: number): number {
  const mix = (c: number): number => c + (255 - c) * t;
  return rgb(mix((color >> 16) & 255), mix((color >> 8) & 255), mix(color & 255));
}

// ---------------------------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------------------------

interface StarDesign {
  cls: StarClass;
  /** kg */
  mass: number;
  /** m */
  radius: number;
  /** K */
  temp: number;
  /** W */
  lum: number;
  color: number;
  /** s */
  rotPeriod: number;
  /** rad */
  tilt: number;
  scoopable: boolean;
  /** m */
  rs?: number;
  disk?: NonNullable<BodyDef['disk']>;
  jets?: NonNullable<BodyDef['jets']>;
}

/** Main-sequence classes by mass range in solar masses, lightest first. */
const MS_CLASSES: readonly { cls: StarClass; lo: number; hi: number }[] = [
  { cls: 'M', lo: 0.08, hi: 0.45 },
  { cls: 'K', lo: 0.45, hi: 0.8 },
  { cls: 'G', lo: 0.8, hi: 1.04 },
  { cls: 'F', lo: 1.04, hi: 1.4 },
  { cls: 'A', lo: 1.4, hi: 2.1 },
  { cls: 'B', lo: 2.1, hi: 16 },
  { cls: 'O', lo: 16, hi: 60 },
];

/** Main-sequence anchors: mass (solar masses) against effective temperature (K), at the class boundaries. */
const MS_TEMPERATURE: readonly (readonly [number, number])[] = [
  [0.08, 2400], [0.45, 3700], [0.8, 5200], [1, SOLAR_TEMP], [1.04, 6000], [1.4, 7500], [2.1, 10_000], [16, 30_000], [60, 45_000],
];

/** Effective temperature (K) of a main-sequence star of `m` solar masses: log-log interpolation of the anchors. */
function msTemperature(m: number): number {
  const first = MS_TEMPERATURE[0]!;
  const last = MS_TEMPERATURE[MS_TEMPERATURE.length - 1]!;
  if (m <= first[0]) return first[1];
  for (let i = 1; i < MS_TEMPERATURE.length; i++) {
    const [m1, t1] = MS_TEMPERATURE[i]!;
    if (m <= m1) {
      const [m0, t0] = MS_TEMPERATURE[i - 1]!;
      const f = Math.log(m / m0) / Math.log(m1 / m0);
      return t0 * (t1 / t0) ** f;
    }
  }
  return last[1];
}

/** Mass-luminosity relation of the main sequence; both in solar units. */
function msLuminosity(m: number): number {
  if (m < 0.43) return 0.23 * m ** 2.3;
  if (m < 2) return m ** 4;
  if (m < 55) return 1.4 * m ** 3.5;
  return 32_000 * m;
}

/** Luminosity (W) of a sphere of the given radius (m) radiating as a black body at `temp` (K). */
const blackbodyLuminosity = (radius: number, temp: number): number => 4 * Math.PI * radius * radius * SIGMA * temp ** 4;

/** A main-sequence star of `m` solar masses. Luminosity, radius and temperature obey L = 4 pi R^2 sigma T^4. */
function designMainSequence(rng: Rng, m: number): StarDesign {
  const band = MS_CLASSES.find((c) => m < c.hi) ?? MS_CLASSES[MS_CLASSES.length - 1]!;
  // Jitter stays inside the temperature range of the class so class and colour always agree.
  const temp = clamp(msTemperature(m) * rng.range(0.985, 1.015), msTemperature(band.lo), msTemperature(band.hi));
  const lumSolar = msLuminosity(m) * Math.exp(clamp(rng.gaussian(0, 0.06), -0.15, 0.15));
  const radius = SOLAR_RADIUS * Math.sqrt(lumSolar) * (SOLAR_TEMP / temp) ** 2;
  let rotDays: number;
  switch (band.cls) {
    case 'M': rotDays = rng.logRange(4, 120); break;
    case 'K': rotDays = rng.range(18, 48); break;
    case 'G': rotDays = rng.range(14, 36); break;
    case 'F': rotDays = rng.range(2, 10); break;
    default: rotDays = rng.range(0.4, 3);
  }
  return {
    cls: band.cls,
    mass: m * SOLAR_MASS,
    radius,
    temp,
    lum: lumSolar * SOLAR_LUMINOSITY,
    color: blackbodyColor(temp),
    rotPeriod: rotDays * DAY,
    tilt: rng.range(0, 0.2),
    scoopable: true,
  };
}

/** A white dwarf: about Earth-sized, radius shrinking with mass, cooling from 32000 K to 6000 K. */
function designWhiteDwarf(rng: Rng, maxSolar = 1.25): StarDesign {
  const m = clamp(rng.gaussian(0.62, 0.12), 0.45, Math.max(0.45, maxSolar));
  const radius = 0.0101 * SOLAR_RADIUS * m ** (-1 / 3);
  const temp = rng.logRange(6000, 32_000);
  return {
    cls: 'WD',
    mass: m * SOLAR_MASS,
    radius,
    temp,
    lum: blackbodyLuminosity(radius, temp),
    color: blackbodyColor(temp),
    rotPeriod: rng.logRange(0.02, 3) * DAY,
    tilt: rng.range(0, 0.3),
    scoopable: false,
  };
}

/** A pulsar: 1.2 to 2.2 solar masses in a sphere of about 11 km, with jets along its spin axis. */
function designNeutronStar(rng: Rng): StarDesign {
  const u = rng.float();
  const mass = (1.2 + u * u) * SOLAR_MASS;
  const radius = rng.range(10_500, 12_500);
  // Thermal surface emission: a few hundredths to half a solar luminosity.
  const temp = rng.logRange(5e5, 1.2e6);
  const star: StarDesign = {
    cls: 'NS',
    mass,
    radius,
    temp,
    lum: blackbodyLuminosity(radius, temp),
    color: blackbodyColor(temp),
    rotPeriod: rng.logRange(1.5, 12),
    tilt: rng.range(0, 0.6),
    scoopable: false,
    rs: (2 * G * mass) / (C * C),
    jets: { length: rng.logRange(8e8, 2.5e9), color: jitterColor(rng, 0x8fc4ff, 0.08) },
  };
  if (rng.chance(0.25)) {
    star.disk = { inner: radius * rng.range(20, 60), outer: rng.logRange(1.5e8, 8e8), color: jitterColor(rng, 0xffb070, 0.1) };
  }
  return star;
}

/** A stellar black hole of 5 to 30 solar masses with an accretion disk bright enough to be seen from afar. */
function designBlackHole(rng: Rng): StarDesign {
  const mass = rng.logRange(5, 30) * SOLAR_MASS;
  const rs = (2 * G * mass) / (C * C);
  const temp = rng.range(4500, 11_000);
  const color = blackbodyColor(temp);
  const diskOuter = rng.logRange(1e9, 5e9);
  const star: StarDesign = {
    cls: 'BH',
    mass,
    radius: rs,
    temp,
    lum: rng.logRange(0.5, 5) * SOLAR_LUMINOSITY,
    color,
    // What a distant observer sees turning is the rim of the disk; the horizon itself spins in milliseconds.
    rotPeriod: orbitalPeriod(diskOuter, mass),
    tilt: rng.range(0, 0.5),
    scoopable: false,
    rs,
    disk: { inner: 3 * rs, outer: diskOuter, color },
  };
  if (rng.chance(0.35)) star.jets = { length: rng.logRange(1e9, 4e9), color: jitterColor(rng, 0xa8b8ff, 0.08) };
  return star;
}

/** Relative frequency of primary classes for ordinary systems. */
const CLASS_WEIGHTS: readonly (readonly [StarClass, number])[] = [
  ['M', 40], ['K', 20], ['G', 13], ['F', 9], ['A', 6], ['WD', 5], ['NS', 2.5], ['B', 2], ['BH', 1.8], ['O', 0.7],
];

function designStar(rng: Rng, cls: StarClass): StarDesign {
  if (cls === 'WD') return designWhiteDwarf(rng);
  if (cls === 'NS') return designNeutronStar(rng);
  if (cls === 'BH') return designBlackHole(rng);
  const band = MS_CLASSES.find((c) => c.cls === cls)!;
  const lo = cls === 'M' ? 0.09 : band.lo;
  const hi = cls === 'O' ? 50 : band.hi;
  // Massive stars are rare within their class too, so B and O draw toward the light end.
  const u = cls === 'B' || cls === 'O' ? rng.float() ** 2 : rng.float();
  return designMainSequence(rng, lo * (hi / lo) ** (u * 0.999));
}

/** The class of the primary: fixed for the showcase indices, otherwise drawn from `CLASS_WEIGHTS`. */
function primaryClass(rng: Rng, index: number): StarClass {
  if (index === 0) return (['F', 'G', 'K'] as const)[rng.weighted([2, 5, 3])]!;
  if (index === 3) return 'BH';
  if (index === 5) return 'NS';
  return CLASS_WEIGHTS[rng.weighted(CLASS_WEIGHTS.map((c) => c[1]))]![0];
}

const isCompact = (cls: StarClass | PlanetClass): boolean => cls === 'WD' || cls === 'NS' || cls === 'BH';

/** Distance (m) from the primary at which ships arrive from a fold jump. */
const foldArrivalDistance = (star: { radius: number }): number => Math.max(FOLD_ARRIVAL_RADII * star.radius, FOLD_ARRIVAL_MIN);

/** Distance (m) from a compact object at which its Newtonian pull equals `ANOMALY_MAX_GRAVITY`. */
const calmDistance = (mass: number): number => Math.sqrt((G * mass) / ANOMALY_MAX_GRAVITY);

// ---------------------------------------------------------------------------------------------
// Planets and moons
// ---------------------------------------------------------------------------------------------

type BodyDraft = Omit<BodyDef, 'id' | 'name'>;

/** Equilibrium temperature bounds (K) of the habitable zone and the frost line. */
const HAB_TEQ_MIN = 215;
const HAB_TEQ_MAX = 310;
const FROST_TEQ = 170;

/** Black-body equilibrium temperature (K) at distance `a` (m) from a star of luminosity `lum` (W). */
const equilibriumTemp = (lum: number, a: number): number =>
  (278 * (lum / SOLAR_LUMINOSITY) ** 0.25) / Math.sqrt(a / AU);

const isGiant = (cls: StarClass | PlanetClass): boolean => cls === 'gas' || cls === 'icegiant';

const density = (mass: number, radius: number): number => mass / ((4 / 3) * Math.PI * radius ** 3);

/** Hill radius (m) of a body on the given orbit around a parent of mass `parentMass`. */
const hillRadius = (mass: number, orbit: { a: number; e: number }, parentMass: number): number =>
  orbit.a * (1 - orbit.e) * Math.cbrt(mass / (3 * parentMass));

/** Fluid Roche limit (m) of a primary for satellites of density `satDensity` (kg/m^3). */
const rocheLimit = (primaryMass: number, satDensity: number): number =>
  2.44 * Math.cbrt((3 * primaryMass) / (4 * Math.PI * satDensity));

/** Planet counts (inclusive range) by class of the primary. */
const PLANET_COUNT: Record<StarClass, readonly [number, number]> = {
  O: [0, 3], B: [0, 4], A: [1, 6], F: [2, 8], G: [3, 9], K: [2, 8], M: [1, 7], WD: [0, 4], NS: [0, 3], BH: [0, 3],
};

/** How readily a star of this class hosts living worlds (1 = sun-like). */
const HABITABILITY: Record<StarClass, number> = {
  O: 0, B: 0, A: 0.4, F: 1, G: 1, K: 1, M: 0.5, WD: 0.3, NS: 0, BH: 0,
};

const PLANET_CLASSES: readonly PlanetClass[] = ['rocky', 'desert', 'lava', 'ice', 'ocean', 'terran', 'gas', 'icegiant'];

const PLANET_COLORS: Record<PlanetClass, readonly number[]> = {
  rocky: [0x8c8378, 0x9a8f86, 0x6f6a66, 0xa39683],
  desert: [0xc79a5e, 0xb8743f, 0xd9b27c, 0xa8623a],
  lava: [0x4a2218, 0x5c2a1c, 0x3a1c16, 0x70301a],
  ice: [0xdfeaf2, 0xc9dbe8, 0xe8eef0, 0xb7cfe0],
  ocean: [0x1f5fa8, 0x2a72b8, 0x1b4f8f, 0x2d7fa6],
  terran: [0x3f7f5a, 0x4a8a66, 0x3a7a78, 0x5a8f4f],
  gas: [0xc9a878, 0xd8b890, 0xb07a50, 0xe0cfa8, 0xa86a48, 0x9fb8d0],
  icegiant: [0x7fc4d8, 0x5a8fd6, 0x8fd8d0, 0x4a74c8],
};

/** Atmosphere recipe by class: chance, surface density range (Earth = 1), mean molar mass (g/mol), colours. */
const ATMOSPHERES: Record<PlanetClass, { chance: number; lo: number; hi: number; molar: number; colors: readonly number[] }> = {
  rocky: { chance: 0.12, lo: 0.0005, hi: 0.02, molar: 44, colors: [0xb9a58c] },
  desert: { chance: 0.85, lo: 0.005, hi: 0.4, molar: 44, colors: [0xd9a273, 0xe0b890, 0xc98f6a] },
  lava: { chance: 0.7, lo: 0.5, hi: 60, molar: 50, colors: [0xff7a45, 0xe8603a, 0xc9743f] },
  ice: { chance: 0.15, lo: 0.001, hi: 0.05, molar: 28, colors: [0xcfe0ff] },
  ocean: { chance: 1, lo: 0.8, hi: 2.2, molar: 28, colors: [0x7ab8ff, 0x8cc6ff] },
  terran: { chance: 1, lo: 0.7, hi: 1.5, molar: 29, colors: [0x6aa8ff, 0x7fb5ff] },
  gas: { chance: 1, lo: 1, hi: 3, molar: 2.3, colors: [] },
  icegiant: { chance: 1, lo: 1, hi: 2.5, molar: 2.6, colors: [0xa8e0f0, 0x8fb8ff] },
};

/** Picks the class of a planet from its equilibrium temperature. */
function choosePlanetClass(rng: Rng, teq: number, habitability: number, gasAllowed: boolean): PlanetClass {
  const w: Record<PlanetClass, number> = { rocky: 0, desert: 0, lava: 0, ice: 0, ocean: 0, terran: 0, gas: 0, icegiant: 0 };
  if (teq >= 900) {
    w.lava = 80; w.rocky = 12; w.gas = 8;
  } else if (teq >= HAB_TEQ_MAX) {
    w.desert = 42; w.rocky = 42; w.lava = teq > 650 ? 8 : 0; w.gas = 6; w.icegiant = 2;
  } else if (teq >= HAB_TEQ_MIN) {
    w.terran = 26 * habitability; w.ocean = 17 * habitability; w.desert = 22; w.rocky = 18; w.gas = 8; w.icegiant = 2;
  } else if (teq >= FROST_TEQ) {
    w.rocky = 40; w.desert = 28; w.gas = 20; w.icegiant = 6; w.ice = 6;
  } else if (teq >= 60) {
    w.gas = 38; w.icegiant = 22; w.ice = 33; w.rocky = 7;
  } else {
    w.icegiant = 30; w.ice = 50; w.gas = 17; w.rocky = 3;
  }
  if (!gasAllowed) {
    // Light stars cannot hold a gas giant on a stable orbit; an ice giant takes its place.
    w.icegiant += w.gas;
    w.gas = 0;
  }
  return PLANET_CLASSES[rng.weighted(PLANET_CLASSES.map((c) => w[c]))]!;
}

/** Mass (kg) and radius (m) of a planet or moon of the given class; `m` is its mass in Earth masses. */
function radiusFor(cls: PlanetClass, m: number): number {
  switch (cls) {
    case 'ice': return EARTH_RADIUS * 1.2 * m ** 0.3;
    case 'ocean': return EARTH_RADIUS * 1.08 * m ** 0.27;
    case 'terran':
    case 'lava': return EARTH_RADIUS * m ** 0.27;
    case 'icegiant': return EARTH_RADIUS * 3.95 * (m / 15.8) ** 0.15;
    case 'gas': {
      const mj = (m * EARTH_MASS) / JUPITER_MASS;
      return JUPITER_RADIUS * (mj < 1 ? mj ** 0.1 : mj ** -0.04);
    }
    default: return EARTH_RADIUS * m ** 0.28;
  }
}

/** Mean surface temperature (K): equilibrium temperature corrected for albedo and greenhouse warming. */
function surfaceTemp(rng: Rng, cls: PlanetClass, teq: number): number {
  switch (cls) {
    // Living worlds regulate their greenhouse, so they stay between freezing and about 45 C.
    case 'terran':
    case 'ocean': return clamp(288 + (teq - 255) * 0.35 + rng.range(-5, 5), 274, 318);
    case 'lava': return teq * (1 - rng.range(0.05, 0.15)) ** 0.25 + rng.range(0, 300);
    case 'desert': return teq * (1 - rng.range(0.18, 0.3)) ** 0.25 + rng.range(0, 12);
    case 'ice': return teq * (1 - rng.range(0.5, 0.7)) ** 0.25;
    case 'gas': return teq * (1 - rng.range(0.3, 0.5)) ** 0.25;
    case 'icegiant': return teq * (1 - rng.range(0.28, 0.4)) ** 0.25;
    default: return teq * (1 - rng.range(0.08, 0.2)) ** 0.25;
  }
}

function designAtmosphere(
  rng: Rng, cls: PlanetClass, mass: number, radius: number, temp: number, bodyColor: number, chanceScale = 1,
): BodyDef['atmo'] {
  const recipe = ATMOSPHERES[cls];
  if (!rng.chance(recipe.chance * chanceScale)) return undefined;
  const gravity = (G * mass) / (radius * radius);
  const scaleHeight = (K_B * temp) / (recipe.molar * M_U * gravity);
  const color = recipe.colors.length > 0 ? jitterColor(rng, rng.pick(recipe.colors), 0.06) : lighten(bodyColor, 0.35);
  return {
    height: clamp(7 * scaleHeight, 0.006 * radius, 0.05 * radius),
    color,
    density: rng.logRange(recipe.lo, recipe.hi),
  };
}

interface PlanetDesign {
  body: BodyDraft;
  moons: BodyDraft[];
  /** Hill radius divided by the periapsis distance. */
  hillFraction: number;
}

/** Designs the planet on the given orbit. `forceHabitable` makes it a living terran or ocean world. */
function designPlanet(rng: Rng, star: StarDesign, a: number, e: number, forceHabitable: boolean): PlanetDesign {
  const teq = equilibriumTemp(star.lum, a);
  const giantCap = Math.min(4, (0.004 * star.mass) / JUPITER_MASS);
  const cls: PlanetClass = forceHabitable
    ? (rng.chance(0.65) ? 'terran' : 'ocean')
    : choosePlanetClass(rng, teq, HABITABILITY[star.cls], giantCap >= 0.3);

  let earths: number;
  switch (cls) {
    case 'rocky': earths = rng.logRange(0.02, 2.5); break;
    case 'desert': earths = rng.logRange(0.08, 3); break;
    case 'lava': earths = rng.logRange(0.3, 6); break;
    case 'terran': earths = rng.logRange(0.5, 3.5); break;
    case 'ocean': earths = rng.logRange(0.8, 6); break;
    case 'ice': earths = rng.logRange(0.004, 1.5); break;
    case 'icegiant': earths = rng.logRange(10, 30); break;
    default: earths = (rng.logRange(0.3, giantCap) * JUPITER_MASS) / EARTH_MASS;
  }
  const mass = earths * EARTH_MASS;
  let radius = radiusFor(cls, earths) * rng.range(0.96, 1.04);
  // Strongly irradiated gas giants are inflated.
  if (cls === 'gas' && teq > 1000) radius *= rng.range(1.1, 1.35);

  const period = orbitalPeriod(a, star.mass);
  const orbit: OrbitDef = {
    parent: 0,
    a,
    e,
    inc: rng.range(0, 4) * (Math.PI / 180),
    node: rng.range(0, TWO_PI),
    argp: rng.range(0, TWO_PI),
    m0: rng.range(0, TWO_PI),
    period,
  };

  // Close-in planets are tidally locked to the star.
  const locked = period < 25 * DAY;
  let rotPeriod = period;
  if (!locked) {
    rotPeriod = isGiant(cls) ? rng.range(8, 20) * 3600 : rng.logRange(8 * 3600, 60 * DAY);
    if (rng.chance(0.06)) rotPeriod = -rotPeriod;
  }
  const tilt = locked ? rng.range(0, 0.05) : Math.min(Math.abs(rng.gaussian(0, 0.3)), 1.2);

  const color = jitterColor(rng, rng.pick(PLANET_COLORS[cls]), 0.08);
  const temp = surfaceTemp(rng, cls, teq);
  const body: BodyDraft = { kind: 'planet', cls, mass, radius, orbit, rotPeriod, tilt, seed: rng.u32(), color, temp };
  const atmo = designAtmosphere(rng, cls, mass, radius, temp, color);
  if (atmo) body.atmo = atmo;
  if (cls === 'terran' || cls === 'ocean') body.habitable = true;

  if (isGiant(cls) && rng.chance(0.45)) {
    // Rings of ice survive only inside the Roche limit of the planet.
    const roche = rocheLimit(mass, 930);
    if (roche >= 1.75 * radius) {
      const outer = Math.min(rng.range(1.9, 2.5) * radius, 0.97 * roche);
      const inner = Math.min(rng.range(1.25, 1.6) * radius, outer / 1.3);
      const ringColor = teq < FROST_TEQ ? 0xd6cdb8 : 0x9a8c7a;
      body.rings = { inner, outer, color: jitterColor(rng, ringColor, 0.08), seed: rng.u32() };
    }
  }

  const hillFraction = Math.cbrt(mass / (3 * star.mass));
  return { body, moons: [], hillFraction };
}

/**
 * Moons of a planet: outside the Roche limit and the rings, inside a third of the Hill sphere,
 * on near-circular orbits in the planet's equatorial plane. Their `orbit.parent` is set by the caller.
 */
function designMoons(rng: Rng, planet: BodyDraft, star: StarDesign): BodyDraft[] {
  const orbit = planet.orbit!;
  const giant = isGiant(planet.cls);
  const count = giant ? rng.weighted([1, 3, 4, 3, 2]) : planet.mass > 0.05 * EARTH_MASS && rng.chance(0.3) ? 1 : 0;
  const limit = hillRadius(planet.mass, orbit, star.mass) / 3;
  const planetDensity = density(planet.mass, planet.radius);
  // Icy moons are the least dense, so their Roche limit is the conservative one.
  const roche = 2.44 * planet.radius * Math.cbrt(planetDensity / 1800);
  const minA = giant
    ? Math.max(4.5 * planet.radius, (planet.rings?.outer ?? 0) * 1.3, roche * 1.1)
    : Math.max(8 * planet.radius, roche * 1.1);
  const teq = equilibriumTemp(star.lum, orbit.a);

  const moons: BodyDraft[] = [];
  let a = minA * rng.range(1.1, 2.2);
  for (let i = 0; i < count; i++) {
    const e = rng.range(0, 0.03);
    if (a * (1 + e) > limit) break;
    const earths = (planet.mass * (giant ? rng.logRange(3e-6, 2.5e-4) : rng.logRange(2e-4, 0.015))) / EARTH_MASS;
    let cls: PlanetClass;
    if (teq < FROST_TEQ) cls = rng.chance(0.85) ? 'ice' : 'rocky';
    else if (giant && i === 0 && rng.chance(0.25)) cls = 'lava';
    else cls = earths > 0.01 && rng.chance(0.2) ? 'desert' : 'rocky';
    const mass = earths * EARTH_MASS;
    const radius = radiusFor(cls, earths) * rng.range(0.96, 1.04);
    const period = orbitalPeriod(a, planet.mass);
    const temp = cls === 'lava' ? rng.range(900, 1500) : surfaceTemp(rng, cls, teq);
    const color = jitterColor(rng, rng.pick(PLANET_COLORS[cls]), 0.08);
    const moon: BodyDraft = {
      kind: 'moon',
      cls,
      mass,
      radius,
      orbit: {
        parent: -1,
        a,
        e,
        inc: Math.max(0, planet.tilt + rng.range(-0.01, 0.01)),
        // The equatorial plane has node 0; with almost no tilt the node is arbitrary.
        node: planet.tilt > 0.05 ? rng.range(-0.02, 0.02) : rng.range(0, TWO_PI),
        argp: rng.range(0, TWO_PI),
        m0: rng.range(0, TWO_PI),
        period,
      },
      // Moons are tidally locked to their planet.
      rotPeriod: period,
      tilt: planet.tilt,
      seed: rng.u32(),
      color,
      temp,
    };
    // Only massive moons hold on to an atmosphere.
    if (earths > 0.015) {
      const atmo = designAtmosphere(rng, cls, mass, radius, temp, color, 0.6);
      if (atmo) moon.atmo = atmo;
    }
    moons.push(moon);
    a *= rng.range(1.45, 2.1);
  }
  return moons;
}

// ---------------------------------------------------------------------------------------------
// Orbit planning
// ---------------------------------------------------------------------------------------------

/** Belt edges as fractions of the slot's semi-major axis. */
const BELT_INNER_MIN = 0.86;
const BELT_INNER_MAX = 0.93;
const BELT_OUTER_MIN = 1.07;
const BELT_OUTER_MAX = 1.16;

type Slot =
  /** `home` marks the capital's guaranteed habitable world. */
  | { kind: 'planet'; a: number; design: PlanetDesign; home: boolean }
  | { kind: 'belt'; a: number };

/** Closest distance (m) from the primary at which planets and belts can exist. */
function innerOrbitLimit(star: StarDesign): number {
  const lumSolar = star.lum / SOLAR_LUMINOSITY;
  // Three stellar radii, the line where rock starts to melt (about 1100 K), and the Roche limit for a gas giant.
  const base = Math.max(3 * star.radius, 0.06 * AU * Math.sqrt(lumSolar), rocheLimit(star.mass, 900));
  // Compact primaries have swallowed or scattered their inner systems.
  if (star.cls === 'WD') return Math.max(base, 0.25 * AU);
  if (star.cls === 'NS' || star.cls === 'BH') return Math.max(base, 0.6 * AU, 4 * calmDistance(star.mass));
  return base;
}

/**
 * Plans the planets and belts around the primary from the inside out. Orbits are spaced
 * geometrically (ratio 1.4 to 2.1), belts take a slot of their own so they lie in a gap between
 * planets, and no planet's neighbourhood reaches the shell where ships arrive from a fold jump.
 * The capital gets one planet forced into the habitable zone.
 */
function planOrbits(rng: Rng, star: StarDesign, capital: boolean): Slot[] {
  const [lo, hi] = PLANET_COUNT[star.cls];
  const planets = capital ? Math.max(4, rng.int(lo, hi)) : rng.int(lo, hi);
  const wantedBelts = rng.weighted([40, 42, 18]);
  const forcedPlanet = capital ? rng.int(1, Math.min(3, planets - 1)) : -1;

  // A belt sits in a gap: before planet g, or after the last planet when g = planets.
  const beltGaps = new Set<number>();
  for (let i = 0; i < wantedBelts; i++) beltGaps.add(rng.int(0, planets));
  const kinds: ('planet' | 'belt')[] = [];
  let forcedSlot = -1;
  for (let g = 0; g <= planets; g++) {
    if (beltGaps.has(g)) kinds.push('belt');
    if (g < planets) {
      if (g === forcedPlanet) forcedSlot = kinds.length;
      kinds.push('planet');
    }
  }
  if (kinds.length === 0) return [];

  // Slots next to a belt keep a wider ratio so the belt clears the Hill spheres of its neighbours.
  const ratios = kinds.map((k, i) => (i === 0 ? 1 : rng.range(k === 'belt' || kinds[i - 1] === 'belt' ? 1.55 : 1.4, 2.1)));
  const limit = innerOrbitLimit(star);
  const arrival = foldArrivalDistance(star);

  /** Builds the slot at semi-major axis `a`; null when it does not fit and may not be moved outward. */
  const makeSlot = (kind: 'planet' | 'belt', a: number, forced: boolean, movable: boolean): Slot | null => {
    if (kind === 'belt') {
      if (a * BELT_INNER_MIN >= limit) return { kind, a };
      return movable ? { kind, a: (limit / BELT_INNER_MIN) * 1.02 } : null;
    }
    const e = rng.range(0, 0.08);
    const seed = rng.u32();
    for (let tries = 0; ; tries++) {
      const design = designPlanet(rngFor(seed, 'planet'), star, a, e, forced);
      const reach = 3 * design.hillFraction;
      const nearArrival = a * (1 - e) * (1 - reach) < 1.2 * arrival && a * (1 + e) * (1 + reach) > 0.9 * arrival;
      const tooClose = a * (1 - e) < limit;
      if (forced || tries >= 24 || !(nearArrival || tooClose)) {
        design.moons = designMoons(rngFor(seed, 'moons'), design.body, star);
        return { kind, a, design, home: forced };
      }
      if (!movable) return null;
      a *= 1.12;
    }
  };

  const slots: Slot[] = [];
  let a: number;
  let first = 0;
  if (forcedSlot >= 0) {
    const habitable = AU * Math.sqrt(star.lum / SOLAR_LUMINOSITY) * rng.range(0.9, 1.4);
    // Inner slots are laid out inward from the habitable orbit and dropped when they do not fit.
    const inner: number[] = [];
    a = habitable;
    for (let k = forcedSlot; k > 0; k--) {
      a /= ratios[k]!;
      inner.unshift(a);
    }
    for (let k = 0; k < forcedSlot; k++) {
      const slot = makeSlot(kinds[k]!, inner[k]!, false, false);
      if (slot) slots.push(slot);
    }
    slots.push(makeSlot('planet', habitable, true, false)!);
    a = habitable;
    first = forcedSlot + 1;
  } else {
    a = limit * (isCompact(star.cls) ? rng.logRange(1.05, 2.5) : rng.logRange(1.2, 6));
    const slot = makeSlot(kinds[0]!, a, false, true)!;
    a = slot.a;
    slots.push(slot);
    first = 1;
  }
  for (let k = first; k < kinds.length; k++) {
    a *= ratios[k]!;
    const slot = makeSlot(kinds[k]!, a, false, true)!;
    a = slot.a;
    slots.push(slot);
  }
  return slots;
}

/** Outermost distance (m) from the primary that the planned planets (with their Hill spheres) and belts reach. */
function plannedExtent(slots: readonly Slot[]): number {
  let extent = 0;
  for (const s of slots) {
    if (s.kind === 'belt') extent = Math.max(extent, s.a * BELT_OUTER_MAX);
    else extent = Math.max(extent, s.a * (1 + s.design.body.orbit!.e) * (1 + s.design.hillFraction));
  }
  return extent;
}

/**
 * Orbit radius (m) around the primary for stations in a system without a usable planet: where a
 * black body sits near 300 K, clear of the fold arrival shell; between the anomalies and the
 * planets for neutron stars and black holes.
 */
function openSpaceRadius(star: { cls: StarClass | PlanetClass; mass: number; radius: number; lum?: number }): number {
  if (star.cls === 'NS' || star.cls === 'BH') return 2 * calmDistance(star.mass);
  const lumSolar = (star.lum ?? 0) / SOLAR_LUMINOSITY;
  return Math.max(0.86 * AU * Math.sqrt(lumSolar), 1.6 * foldArrivalDistance(star));
}

/** A companion star for body 1, light enough that the primary keeps its planets. Null when none fits. */
function designCompanion(rng: Rng, primary: StarDesign): StarDesign | null {
  const primarySolar = primary.mass / SOLAR_MASS;
  const cap = 0.5 * primarySolar;
  if (cap < 0.1) return null;
  if (!isCompact(primary.cls) && cap >= 0.5 && rng.chance(0.12)) return designWhiteDwarf(rng, cap);
  const m = isCompact(primary.cls) ? rng.logRange(0.09, Math.min(0.9, cap)) : Math.max(0.09, primarySolar * rng.range(0.15, 0.5));
  return designMainSequence(rng, m);
}

// ---------------------------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------------------------

const ALL_SERVICES: readonly StationService[] = ['market', 'outfit', 'shipyard', 'missions', 'repair', 'refuel', 'cartography'];
const OUTPOST_SERVICES: readonly StationService[] = ['market', 'refuel', 'repair', 'missions'];

/** Appends a site, giving it the anchor id that matches its index in `sites`. */
function addSite(sites: SiteDef[], site: Omit<SiteDef, 'id'>): SiteDef {
  const full: SiteDef = { id: SITE_ID_BASE + sites.length, ...site };
  sites.push(full);
  return full;
}

/** A planet a station can orbit, with the economy its surroundings suggest. */
interface DockHost {
  body: BodyDef;
  economy: EconomyType;
  weight: number;
  /** Largest stable orbit radius around the body, m. */
  maxOrbit: number;
  used: number;
}

function dockHosts(bodies: readonly BodyDef[], hasBelts: boolean): DockHost[] {
  const star = bodies[0]!;
  const hosts: DockHost[] = [];
  for (const body of bodies) {
    if (body.kind !== 'planet' || !body.orbit || body.orbit.parent !== 0) continue;
    const giant = isGiant(body.cls);
    const minOrbit = giant ? Math.max(1.8 * body.radius, (body.rings?.outer ?? 0) * 1.12) : body.radius + 350e3;
    const maxOrbit = 0.45 * hillRadius(body.mass, body.orbit, star.mass);
    if (maxOrbit < minOrbit) continue;
    let economy: EconomyType;
    let weight: number;
    if (body.cls === 'terran' || body.cls === 'ocean') {
      economy = 'agri';
      weight = 10;
    } else if (giant) {
      economy = 'refinery';
      weight = 5;
    } else {
      economy = 'mining';
      weight = (body.cls === 'lava' ? 1.5 : 3) + (hasBelts ? 2 : 0);
    }
    hosts.push({ body, economy, weight, maxOrbit, used: 0 });
  }
  return hosts;
}

/** Orbit radius (m) for a station around a host: low above rocky worlds, 2 to 3 radii out at giants, beyond any rings. */
function dockOrbitRadius(rng: Rng, host: DockHost): number {
  const b = host.body;
  const r = isGiant(b.cls)
    ? Math.max(rng.range(2, 3) * b.radius, (b.rings?.outer ?? 0) * 1.12)
    : b.radius + rng.range(400e3, 3500e3);
  // A second station at the same world flies higher, well clear of the first one's zone.
  const stacked = isGiant(b.cls) ? r * (1 + 0.25 * host.used) : r + host.used * rng.range(1800e3, 3000e3);
  return Math.min(stacked, host.maxOrbit);
}

interface SystemDraft {
  name: string;
  index: number;
  bodies: BodyDef[];
  belts: BeltDef[];
  /** Body id of the capital's forced habitable planet, or -1. */
  homeworld: number;
  security: Security;
  factions: readonly string[];
}

/** Builds every site of a system. Returns the sites, the number of dockable ones and the controlling faction. */
function buildSites(rng: Rng, sys: SystemDraft): { sites: SiteDef[]; stations: number; security: Security; faction?: string } {
  const { bodies, belts, name } = sys;
  const star = bodies[0]!;
  const capital = sys.index === 0;
  const sites: SiteDef[] = [];
  const taken = new Set<string>([...bodies.map((b) => b.name), ...belts.map((b) => b.name)]);

  // --- stations and outposts ---
  let security = sys.security;
  let stationCount = 0;
  let outpostCount = 0;
  if (capital) {
    stationCount = 2 + (rng.chance(0.4) ? 1 : 0);
    outpostCount = rng.int(0, 2);
  } else if (!rng.chance(0.35)) {
    if (security === 'secure') {
      stationCount = rng.int(1, 2);
      outpostCount = rng.int(0, 2);
    } else if (security === 'frontier') {
      stationCount = rng.chance(0.45) ? 1 : 0;
      outpostCount = rng.int(1, 2);
    } else {
      stationCount = rng.chance(0.15) ? 1 : 0;
      outpostCount = 1 + (rng.chance(0.3) ? 1 : 0);
    }
  } else if (security === 'secure') {
    // Nobody patrols a system without a single station.
    security = 'frontier';
  }
  const dockables = stationCount + outpostCount;
  const faction = dockables > 0 ? sys.factions[capital ? 0 : rng.weighted([5, 3, 2].slice(0, sys.factions.length))] : undefined;
  const developed = capital || security === 'secure';

  const hosts = dockHosts(bodies, belts.length > 0);
  let openSpaceUsed = 0;
  let extent = 0;
  for (const b of bodies) {
    if (b.kind === 'planet' && b.orbit) extent = Math.max(extent, b.orbit.a * (1 + b.orbit.e) + hillRadius(b.mass, b.orbit, star.mass));
  }
  for (const belt of belts) extent = Math.max(extent, belt.outer);

  for (let i = 0; i < dockables; i++) {
    const large = i < stationCount;
    const hub = capital && i === 0;
    // The capital's hub orbits the homeworld; everything else spreads over the free hosts.
    let host: DockHost | undefined;
    if (hub) host = hosts.find((h) => h.body.id === sys.homeworld);
    if (!host) {
      const free = hosts.filter((h) => h.used === 0);
      if (free.length > 0) host = free[rng.weighted(free.map((h) => h.weight))];
      // The capital always keeps its second station, stacked above the hub when no other world fits.
      else if (capital && large) host = hosts.find((h) => h.body.id === sys.homeworld && h.used < 2);
    }

    let orbit: OrbitDef;
    let natural: EconomyType;
    if (host) {
      orbit = circularOrbit(host.body.id, host.body.mass, dockOrbitRadius(rng, host), rng.range(0, TWO_PI));
      natural = host.economy;
      host.used++;
    } else {
      // No world to orbit: a free-flying station around the primary, beyond the planets if there are any.
      const open = openSpaceRadius(star);
      const base = star.cls === 'NS' || star.cls === 'BH' ? open : Math.max(open, extent * 1.25);
      orbit = circularOrbit(0, star.mass, base * (1 + 0.18 * openSpaceUsed), rng.range(0, TWO_PI));
      natural = belts.length > 0 ? 'mining' : isCompact(star.cls) ? 'hightech' : 'industrial';
      openSpaceUsed++;
    }

    let economy: EconomyType;
    if (large) {
      economy = natural;
      if (hub || (developed && rng.chance(0.4))) economy = rng.chance(0.5) ? 'industrial' : 'hightech';
      else if (rng.chance(0.05)) economy = 'military';
    } else {
      // Outposts are too small for anything but digging and refining; the rest just keep travellers supplied.
      economy = (natural === 'mining' || natural === 'refinery') && rng.chance(0.5) ? natural : 'outpost';
    }

    const site: Omit<SiteDef, 'id'> = {
      kind: large ? 'station' : 'outpost',
      name: uniqueName(rng, taken, large ? stationName : outpostName),
      orbit,
      frameRadius: DEFAULT_SITE_FRAME_RADIUS,
      seed: rng.u32(),
      model: large ? 'station_ring' : 'station_outpost',
      radius: large ? 900 : 260,
      services: [...(large ? ALL_SERVICES : OUTPOST_SERVICES)],
      economy,
    };
    // Outside secure space an outpost may answer to a rival faction.
    const rival = !large && security !== 'secure' && sys.factions.length > 1 && rng.chance(0.15);
    site.faction = rival ? rng.pick(sys.factions.filter((f) => f !== faction)) : faction;
    addSite(sites, site);
  }

  // --- belt mining sites ---
  for (const belt of belts) {
    const count = rng.int(3, 6);
    const width = belt.outer - belt.inner;
    for (let k = 0; k < count; k++) {
      // One site per sector of the belt, so two sites never start out on top of each other.
      const phase = ((k + rng.range(0.1, 0.9)) / count) * TWO_PI;
      const a = belt.inner + width * rng.range(0.15, 0.85);
      addSite(sites, {
        kind: 'belt',
        name: `${belt.name} Field ${k + 1}`,
        orbit: circularOrbit(belt.parent, bodies[belt.parent]!.mass, a, phase),
        frameRadius: BELT_SITE_FRAME_RADIUS,
        seed: rng.u32(),
        beltId: belt.id,
      });
    }
  }

  // --- ring mining sites ---
  for (const body of bodies) {
    if (!body.rings) continue;
    const count = rng.int(1, 2);
    const width = body.rings.outer - body.rings.inner;
    for (let k = 0; k < count; k++) {
      const a = body.rings.inner + width * rng.range(0.2, 0.8);
      const phase = ((k + rng.range(0.1, 0.9)) / count) * TWO_PI;
      addSite(sites, {
        kind: 'ring',
        name: `${body.name} Rings ${k + 1}`,
        // The ring plane is the equatorial plane: inclination = tilt, node 0.
        orbit: circularOrbit(body.id, body.mass, a, phase, body.tilt, 0),
        frameRadius: RING_SITE_FRAME_RADIUS,
        seed: rng.u32(),
      });
    }
  }

  // --- anomalies near compact objects ---
  if (star.cls === 'NS' || star.cls === 'BH') {
    const count = rng.int(1, 2);
    let a = calmDistance(star.mass) * rng.range(1.06, 1.25);
    for (let k = 0; k < count; k++) {
      addSite(sites, {
        kind: 'anomaly',
        name: `${name} Anomaly ${'AB'[k]}`,
        orbit: circularOrbit(0, star.mass, a, rng.range(0, TWO_PI), rng.range(0, 0.3), rng.range(0, TWO_PI)),
        frameRadius: BELT_SITE_FRAME_RADIUS,
        seed: rng.u32(),
      });
      a *= rng.range(1.2, 1.3);
    }
  }

  // --- navigation beacon ---
  addSite(sites, {
    kind: 'beacon',
    name: `${name} Beacon`,
    orbit: circularOrbit(0, star.mass, foldArrivalDistance(star) * 1.06, rng.range(0, TWO_PI)),
    frameRadius: BEACON_FRAME_RADIUS,
    seed: rng.u32(),
    model: 'beacon',
    radius: 20,
  });

  const result: { sites: SiteDef[]; stations: number; security: Security; faction?: string } = { sites, stations: dockables, security };
  if (faction !== undefined) result.faction = faction;
  return result;
}

// ---------------------------------------------------------------------------------------------
// Ground bases
// ---------------------------------------------------------------------------------------------

const BASE_SERVICES: readonly StationService[] = ['market', 'refuel', 'repair', 'missions'];
/** Chance that an inhabited system other than the capital has a ground base, given a body to build on. */
const BASE_CHANCE = 0.4;
/** Chance that a system with a base has a second one on another body. */
const BASE_SECOND_CHANCE = 0.25;
/** Directions tried for the spot of a base; the most level one is taken. */
const BASE_SPOT_CANDIDATES = 24;
/** Radius of the bounding sphere of a ground base, metres (the `bound` of the structure `base_ground`). */
const BASE_RADIUS = 250;

/**
 * Unevenness of the ground where a base would stand, as a grade (rise over run): the steepest
 * average grade from the centre to the edge of the pad and to the outer edge of the ring in which
 * the pad meets the terrain. The pad flattens what is inside; this says how much it has to.
 */
function baseSpotGrade(params: ReturnType<typeof terrainParams>, dir: Readonly<Vec3>): number {
  const outer = BASE_PAD_RADIUS + BASE_PAD_BLEND;
  return Math.max(
    terrainRelief(params, dir[0], dir[1], dir[2], BASE_PAD_RADIUS) / BASE_PAD_RADIUS,
    terrainRelief(params, dir[0], dir[1], dir[2], outer) / outer,
  );
}

/**
 * Appends the ground bases of a system to `sites`. They come last and draw from a random stream
 * of their own, so every body, belt and orbital site of the system is exactly what it would be
 * without them.
 *
 * A base stands on a landable body with a surface gravity of at most BASE_MAX_GRAVITY. Only
 * inhabited systems have bases, so a system's faction and whether it has anywhere to dock mean
 * what they did before. The capital has one whenever it has a body to build on; other systems by
 * chance. The spot is the most level of BASE_SPOT_CANDIDATES random directions.
 *
 * Every base is the structure `base_ground` (`GROUND_BASE_STRUCTURE`).
 */
function buildBases(rng: Rng, sys: { index: number; bodies: readonly BodyDef[]; belts: readonly BeltDef[]; faction?: string }, sites: SiteDef[]): void {
  if (sys.faction === undefined) return;
  const hosts = sys.bodies.filter((b) => isLandable(b) && (G * b.mass) / (b.radius * b.radius) <= BASE_MAX_GRAVITY);
  if (hosts.length === 0) return;
  let count = sys.index === 0 || rng.chance(BASE_CHANCE) ? 1 : 0;
  if (count > 0 && rng.chance(BASE_SECOND_CHANCE)) count = 2;
  count = Math.min(count, hosts.length);
  const taken = new Set<string>([...sys.bodies.map((b) => b.name), ...sys.belts.map((b) => b.name), ...sites.map((s) => s.name)]);

  for (let k = 0; k < count; k++) {
    const host = hosts.splice(rng.int(0, hosts.length - 1), 1)[0]!;
    const params = terrainParams(host);
    let best: Vec3 = [0, 1, 0];
    let bestGrade = Infinity;
    for (let i = 0; i < BASE_SPOT_CANDIDATES; i++) {
      const dir = rng.unitVector();
      // The terrain takes unit directions built with square roots only; this one came through
      // sine and cosine, so it is brought to exact unit length here.
      const l = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
      const unit: Vec3 = [dir[0] / l, dir[1] / l, dir[2] / l];
      const grade = baseSpotGrade(params, unit);
      if (grade < bestGrade) {
        bestGrade = grade;
        best = unit;
      }
    }
    // The pad lies at the height the untouched ground has at its centre.
    const r = host.radius + terrainHeight(params, best[0], best[1], best[2]);
    const services: StationService[] = [...BASE_SERVICES];
    if (rng.chance(0.3)) services.push('outfit');
    addSite(sites, {
      kind: 'base',
      name: uniqueName(rng, taken, baseName),
      // No orbit: a ground site moves with its body. The parent says which one.
      orbit: { parent: host.id, a: 0, e: 0, inc: 0, node: 0, argp: 0, m0: 0, period: 0 },
      frameRadius: 0,
      seed: rng.u32(),
      model: 'base_ground',
      radius: BASE_RADIUS,
      services,
      economy: rng.chance(0.6) ? 'mining' : 'outpost',
      faction: sys.faction,
      ground: { body: host.id, pos: [best[0] * r, best[1] * r, best[2] * r] },
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Systems
// ---------------------------------------------------------------------------------------------

/**
 * The 2 or 3 factions of a sector. The first one holds the capital.
 * Depends only on (serverId, seed).
 */
export function sectorFactions(serverId: string, seed: string): string[] {
  const rng = rngFor(seed, serverId, 'factions');
  const count = rng.int(2, 3);
  const taken = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(uniqueName(rng, taken, factionName));
  return out;
}

/**
 * Names of the first `count` systems of a sector, unique within the sector.
 * Name `i` depends only on (serverId, seed, i) and the names before it.
 */
export function sectorSystemNames(serverId: string, seed: string, count: number): string[] {
  const taken = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(uniqueSystemName(rngFor(seed, serverId, 'name', i), taken));
  return out;
}

/** Security of a system: the capital is secure, the rest grow more lawless toward the sector edge. */
function securityFor(rng: Rng, index: number, edge: number): Security {
  if (index === 0) return 'secure';
  const score = edge + rng.range(-0.15, 0.15);
  return score < 0.68 ? 'secure' : score < 0.9 ? 'frontier' : 'lawless';
}

function starBody(id: number, name: string, d: StarDesign, orbit: OrbitDef | null, seed: number): BodyDef {
  const body: BodyDef = {
    id, name, kind: 'star', cls: d.cls, mass: d.mass, radius: d.radius, orbit,
    rotPeriod: d.rotPeriod, tilt: d.tilt, seed, color: d.color, temp: d.temp, lum: d.lum, scoopable: d.scoopable,
  };
  if (d.rs !== undefined) body.rs = d.rs;
  if (d.disk) body.disk = d.disk;
  if (d.jets) body.jets = d.jets;
  return body;
}

function buildSystem(serverId: string, seed: string, index: number, pos: Readonly<Vec3>, name: string): SystemDef {
  const rngStar = rngFor(seed, serverId, index, 'star');
  const star = designStar(rngStar, primaryClass(rngStar, index));
  const slots = planOrbits(rngFor(seed, serverId, index, 'orbits'), star, index === 0);

  const bodies: BodyDef[] = [starBody(0, name, star, null, rngStar.u32())];

  // --- companion star (body 1) ---
  const rngCompanion = rngFor(seed, serverId, index, 'companion');
  // The lightest red dwarfs get no companion (see designCompanion), which brings the overall share to about 12 %.
  if (rngCompanion.chance(0.15)) {
    const companion = designCompanion(rngCompanion, star);
    if (companion) {
      // Wide and nearly circular, so the primary and everything orbiting it stay outside the
      // companion's sphere of influence at every point of the orbit.
      const reach = Math.max(plannedExtent(slots), openSpaceRadius(star));
      const a = Math.max(20 * reach, 60 * AU) * rngCompanion.logRange(1, 3);
      const orbit: OrbitDef = {
        parent: 0,
        a,
        e: rngCompanion.range(0, 0.08),
        inc: rngCompanion.range(0, 0.4),
        node: rngCompanion.range(0, TWO_PI),
        argp: rngCompanion.range(0, TWO_PI),
        m0: rngCompanion.range(0, TWO_PI),
        period: orbitalPeriod(a, star.mass),
      };
      bodies.push(starBody(1, `${name} B`, companion, orbit, rngCompanion.u32()));
    }
  }

  // --- planets, moons and belts, from the inside out ---
  const rngBelts = rngFor(seed, serverId, index, 'belts');
  const beltSlots = slots.filter((s) => s.kind === 'belt');
  const belts: BeltDef[] = [];
  let homeworld = -1;
  let planetNumber = 0;
  for (const slot of slots) {
    if (slot.kind === 'belt') {
      const teq = equilibriumTemp(star.lum, slot.a);
      const kinds: readonly BeltKind[] = ['rock', 'metal', 'ice'];
      const kind = kinds[rngBelts.weighted(teq < FROST_TEQ ? [30, 10, 60] : [55, 40, 5])]!;
      const label = beltSlots.length < 2 ? 'Belt' : belts.length === 0 ? 'Inner Belt' : 'Outer Belt';
      belts.push({
        id: belts.length,
        name: `${name} ${label}`,
        parent: 0,
        inner: slot.a * rngBelts.range(BELT_INNER_MIN, BELT_INNER_MAX),
        outer: slot.a * rngBelts.range(BELT_OUTER_MIN, BELT_OUTER_MAX),
        height: slot.a * rngBelts.range(0.01, 0.06),
        kind,
        richness: rngBelts.range(0.2, 1),
        seed: rngBelts.u32(),
      });
      continue;
    }
    planetNumber++;
    const planet: BodyDef = { id: bodies.length, name: `${name} ${romanNumeral(planetNumber)}`, ...slot.design.body };
    bodies.push(planet);
    if (slot.home) homeworld = planet.id;
    slot.design.moons.forEach((draft, k) => {
      bodies.push({
        id: bodies.length,
        name: `${planet.name} ${moonLetter(k)}`,
        ...draft,
        orbit: { ...draft.orbit!, parent: planet.id },
      });
    });
  }
  // Anchor ids from SURFACE_ID_BASE on belong to the surface frames, one per body.
  if (bodies.length >= SURFACE_ID_BASE) throw new Error(`system ${name} has ${bodies.length} bodies; at most ${SURFACE_ID_BASE - 1} fit below the surface anchor ids`);

  // --- sites, security and faction ---
  const rngSites = rngFor(seed, serverId, index, 'sites');
  const built = buildSites(rngSites, {
    name,
    index,
    bodies,
    belts,
    homeworld,
    security: securityFor(rngFor(seed, serverId, index, 'security'), index, systemEdgeFraction(serverId, seed, index)),
    factions: sectorFactions(serverId, seed),
  });

  // --- ground bases, after everything else and from their own stream ---
  buildBases(rngFor(seed, serverId, index, 'bases'), { index, bodies, belts, faction: built.faction }, built.sites);

  const tags: string[] = [];
  const stars = bodies.filter((b) => b.kind === 'star');
  if (index === 0) tags.push('capital');
  if (stars.some((b) => b.cls === 'BH')) tags.push('blackhole');
  if (stars.some((b) => b.cls === 'NS')) tags.push('neutron');
  if (stars.some((b) => b.cls === 'WD')) tags.push('whitedwarf');
  if (stars.length > 1) tags.push('binary');
  if (belts.length > 0) tags.push('belt');
  if (bodies.some((b) => b.rings)) tags.push('rings');
  if (bodies.some((b) => b.habitable)) tags.push('habitable');
  if (bodies.some((b) => isGiant(b.cls))) tags.push('giant');

  const def: SystemDef = {
    id: `${serverId}:${index}`,
    name,
    pos: [pos[0], pos[1], pos[2]],
    starClass: star.cls,
    security: built.security,
    stations: built.stations,
    tags,
    seed: hashCombine(hashCombine(hashString(seed), hashString(serverId)), index),
    bodies,
    belts,
    sites: built.sites,
  };
  if (built.faction !== undefined) def.faction = built.faction;
  return def;
}

/** Generates all systems of a sector. `result[i].id` is `${serverId}:${i}`. */
export function generateSector(p: SectorParams): SystemDef[] {
  if (!Number.isInteger(p.count) || p.count < 1 || p.count > MAX_SYSTEMS_PER_SECTOR) {
    throw new RangeError(`sector system count must be 1..${MAX_SYSTEMS_PER_SECTOR}, got ${p.count}`);
  }
  const offsets = sectorOffsets(p.serverId, p.seed, p.radius, p.count);
  const names = sectorSystemNames(p.serverId, p.seed, p.count);
  return offsets.map((offset, i) => buildSystem(p.serverId, p.seed, i, v3.add(p.center, offset), names[i]!));
}

/** Generates one system. `pos` is its galactic position. */
export function generateSystem(serverId: string, seed: string, index: number, pos: Vec3): SystemDef {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`invalid system index ${index}`);
  // The name must not collide with any earlier system of the sector, so those are generated too.
  const name = sectorSystemNames(serverId, seed, index + 1)[index]!;
  return buildSystem(serverId, seed, index, pos, name);
}

/**
 * The summary of a system for maps and descriptors. Its `stations` counts everything a pilot can
 * dock at: the stations and outposts (`def.stations`) and the ground bases; a system with a base
 * is tagged `base`.
 */
export function summarize(def: SystemDef): SystemSummary {
  let bases = 0;
  for (const site of def.sites) if (site.kind === 'base') bases++;
  const tags = [...def.tags];
  if (bases > 0 && !tags.includes('base') && tags.length < 12) tags.push('base');
  return {
    id: def.id,
    name: def.name,
    pos: [def.pos[0], def.pos[1], def.pos[2]],
    starClass: def.starClass,
    security: def.security,
    stations: def.stations + bases,
    tags,
  };
}

// ---------------------------------------------------------------------------------------------
// Warp gates
// ---------------------------------------------------------------------------------------------

/** A gate orbits slowly enough that it stays on the side facing its partner for years: period at least this, s. */
const GATE_MIN_PERIOD = 60 * YEAR;

/**
 * Adds a warp gate site to a system (mutating `sys.sites`) and returns it. The gate orbits the
 * primary beyond the outermost planet, on the side facing `towards` (galactic direction to the
 * far end), so its placement is deterministic for both ends. Reuses the existing site when one
 * with the same `gate.linkId` is already present (updating its gate info).
 *
 * The orbit radius depends on the system and `gate.linkId`, the starting phase on `towards`
 * projected onto the system plane (derived from the link id when the direction is vertical or
 * zero). The gate faces `towards` at universe time 0 and drifts along its orbit by at most
 * 6 degrees per year. A new gate also adds the `gate` tag to the system.
 */
export function upsertGateSite(sys: SystemDef, gate: GateInfo, towards: Readonly<Vec3>): SiteDef {
  const existing = sys.sites.find((s) => s.kind === 'gate' && s.gate?.linkId === gate.linkId);
  if (existing) {
    existing.gate = { ...gate };
    return existing;
  }
  const primary = sys.bodies[0];
  if (!primary) throw new Error(`system ${sys.id} has no primary`);
  const rng = rngFor(sys.seed, 'gate', gate.linkId);

  // Everything that orbits the primary directly: planets with their Hill spheres, belts and sites.
  let extent = 2 * foldArrivalDistance(primary);
  let ceiling = Infinity;
  for (const body of sys.bodies) {
    if (!body.orbit || body.orbit.parent !== 0) continue;
    if (body.kind === 'star') {
      // Stay well inside the region the primary controls against a companion.
      ceiling = Math.min(ceiling, 0.8 * (body.orbit.a * (1 - body.orbit.e) - soiRadius(sys, body.id)));
    } else {
      extent = Math.max(extent, body.orbit.a * (1 + body.orbit.e) + hillRadius(body.mass, body.orbit, primary.mass));
    }
  }
  for (const belt of sys.belts) if (belt.parent === 0) extent = Math.max(extent, belt.outer);
  for (const site of sys.sites) {
    if (site.kind !== 'gate' && site.orbit.parent === 0) extent = Math.max(extent, site.orbit.a * (1 + site.orbit.e));
  }
  const slowOrbit = Math.cbrt(G * primary.mass * (GATE_MIN_PERIOD / TWO_PI) ** 2);
  const a = Math.min(Math.max(1.4 * extent, slowOrbit) * (1 + 0.35 * rng.float()), ceiling);

  // A circular orbit in the system plane is at (cos M, 0, -sin M), so this phase points it along `towards`.
  const flat = Math.hypot(towards[0], towards[2]);
  const facing = Number.isFinite(flat) && flat > 1e-9 ? Math.atan2(-towards[2], towards[0]) : rng.range(0, TWO_PI);
  // Two gates toward the same neighbour must not share a spot.
  const phase = facing + rng.range(-0.01, 0.01);

  const site = addSite(sys.sites, {
    kind: 'gate',
    name: `Gate to ${gate.remoteSystem}`,
    orbit: circularOrbit(0, primary.mass, a, phase),
    frameRadius: DEFAULT_SITE_FRAME_RADIUS,
    seed: hashCombine(sys.seed, hashString(gate.linkId)),
    model: 'gate',
    radius: 600,
    gate: { ...gate },
  });
  if (!sys.tags.includes('gate') && sys.tags.length < 12) sys.tags.push('gate');
  return site;
}
