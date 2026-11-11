import type { Vec3 } from '../math.ts';
import { rngFor, type Rng } from '../prng.ts';
import type { AsteroidDef, BeltKind, OreId, SiteDef, SystemDef } from './types.ts';

/** Radius (m) of the sphere around the site anchor that holds no rock, so arriving ships never spawn inside one. */
export const ASTEROID_CLEAR_RADIUS = 800;
/** Smallest gap (m) between the surfaces of two asteroids. */
const MIN_GAP = 15;

type OreTable = readonly (readonly [OreId, number])[];

const BELT_ORES: Record<BeltKind, OreTable> = {
  rock: [['silicates', 45], ['iron_ore', 30], ['copper_ore', 15], ['titanium_ore', 10]],
  metal: [['iron_ore', 45], ['titanium_ore', 25], ['copper_ore', 22], ['platinum_ore', 8]],
  ice: [['ice', 60], ['silicates', 25], ['helium3', 15]],
};
const RING_ORES: OreTable = [['ice', 55], ['silicates', 30], ['iron_ore', 10], ['helium3', 5]];
const ANOMALY_ORES: OreTable = [['exotic_matter', 75], ['platinum_ore', 25]];

/** Units of ore per square metre of cross-section (radius^2) at richness 1, by ore. Rare ores are sparse. */
const ORE_YIELD: Record<OreId, number> = {
  silicates: 0.03,
  iron_ore: 0.025,
  copper_ore: 0.02,
  titanium_ore: 0.014,
  platinum_ore: 0.006,
  ice: 0.03,
  helium3: 0.012,
  exotic_matter: 0.0025,
};

interface FieldSpec {
  count: number;
  /** Horizontal extent of the field around the anchor, m. */
  extent: number;
  /** Vertical extent as a fraction of the horizontal one. */
  flatten: number;
  /** Asteroid radius range, m. */
  minRadius: number;
  maxRadius: number;
  ores: OreTable;
  /** 0..1, scales ore amounts. */
  richness: number;
  /** Largest amount a single asteroid may hold. */
  maxAmount: number;
  /** Tilt (rad) of the field plane about +X; ring fields lie in the ring plane of their planet. */
  tilt: number;
}

/** The shape of the field at a site, or null for sites without asteroids. Uses `rng` only for the count. */
function fieldSpec(sys: SystemDef, site: SiteDef, rng: Rng): FieldSpec | null {
  switch (site.kind) {
    case 'belt': {
      const belt = sys.belts.find((b) => b.id === site.beltId);
      const richness = Math.min(1, Math.max(0, belt?.richness ?? 0.5));
      return {
        // 180 in a poor belt up to 420 in the richest.
        count: 180 + Math.floor(240 * richness * rng.range(0.8, 1)),
        extent: 0.55 * site.frameRadius,
        flatten: 0.3,
        minRadius: 12,
        maxRadius: 450,
        ores: BELT_ORES[belt?.kind ?? 'rock'],
        richness,
        maxAmount: Infinity,
        tilt: 0,
      };
    }
    case 'ring': {
      const parent = sys.bodies[site.orbit.parent];
      return {
        count: rng.int(300, 520),
        extent: 0.5 * site.frameRadius,
        flatten: 0.06,
        minRadius: 6,
        maxRadius: 140,
        ores: RING_ORES,
        richness: 0.6,
        maxAmount: Infinity,
        tilt: parent?.tilt ?? 0,
      };
    }
    case 'anomaly':
      return {
        count: rng.int(40, 80),
        extent: 0.3 * site.frameRadius,
        flatten: 0.6,
        minRadius: 8,
        maxRadius: 60,
        ores: ANOMALY_ORES,
        richness: 1,
        maxAmount: 12,
        tilt: 0,
      };
    default:
      return null;
  }
}

/**
 * Uniform direction without trigonometry: only +, *, / and sqrt are used, which round identically
 * on every engine, so server and client place every rock on exactly the same spot.
 */
function unitVector(rng: Rng): Vec3 {
  for (;;) {
    const x = rng.range(-1, 1);
    const y = rng.range(-1, 1);
    const z = rng.range(-1, 1);
    const sq = x * x + y * y + z * z;
    if (sq > 1e-6 && sq <= 1) {
      const inv = 1 / Math.sqrt(sq);
      return [x * inv, y * inv, z * inv];
    }
  }
}

/** Radius on a power law with cumulative distribution N(> r) ~ 1/r: many small rocks, few large ones. */
const powerLawRadius = (rng: Rng, min: number, max: number): number => min / (1 - rng.float() * (1 - min / max));

/**
 * The asteroids of a `belt`, `ring` or `anomaly` mining site, deterministic from the site seed, positioned
 * relative to the site anchor. Server and client call this with the same arguments and get the
 * same field, so only depletion state needs to cross the network. Returns [] for other site kinds.
 *
 * Fields are densest near the anchor and thin out toward their edge. No two asteroids overlap and
 * none reaches into the sphere of `ASTEROID_CLEAR_RADIUS` around the anchor. `idx` equals the array index.
 */
export function generateAsteroids(sys: SystemDef, site: SiteDef): AsteroidDef[] {
  // Properties and positions come from separate streams, so a placement retry never shifts
  // the ore, size or count of any asteroid.
  const rng = rngFor(site.seed, 'asteroids');
  const places = rngFor(site.seed, 'asteroid-places');
  const spec = fieldSpec(sys, site, rng);
  if (!spec) return [];

  const weights = spec.ores.map((o) => o[1]);
  const cosTilt = Math.cos(spec.tilt);
  const sinTilt = Math.sin(spec.tilt);
  /** Positions in the untilted field frame; overlap tests run here in exact arithmetic. */
  const flat: Vec3[] = [];
  const out: AsteroidDef[] = [];

  for (let idx = 0; idx < spec.count; idx++) {
    let radius = powerLawRadius(rng, spec.minRadius, spec.maxRadius);
    const ore = spec.ores[rng.weighted(weights)]![0];
    const variant = rng.int(0, 3);
    const axis = unitVector(rng);
    // Large bodies tumble slowly.
    const spin = rng.range(0.004, 0.08) / (1 + radius / 60);
    const phase = rng.range(0, 2 * Math.PI);
    const grade = rng.range(0.7, 1.3);

    let pos: Vec3 = [0, 0, 0];
    let extent = spec.extent;
    place: for (let round = 0; ; round++) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const dir = unitVector(places);
        const u = places.float();
        // u * sqrt(u) concentrates the field toward the anchor.
        const r = extent * u * Math.sqrt(u);
        pos = [dir[0] * r, dir[1] * r * spec.flatten, dir[2] * r];
        if (Math.hypot(pos[0], pos[1], pos[2]) - radius < ASTEROID_CLEAR_RADIUS) continue;
        let free = true;
        for (let j = 0; j < idx; j++) {
          const o = out[j]!;
          const p = flat[j]!;
          const reach = radius + o.radius + MIN_GAP;
          const dx = pos[0] - p[0], dy = pos[1] - p[1], dz = pos[2] - p[2];
          if (dx * dx + dy * dy + dz * dz < reach * reach) {
            free = false;
            break;
          }
        }
        if (free) break place;
      }
      // A crowded field: look further out, and after a while settle for a smaller rock.
      extent *= 1.1;
      if (round >= 3) radius = Math.max(spec.minRadius * 0.5, radius * 0.8);
    }

    flat.push(pos);
    const amount = Math.round(ORE_YIELD[ore] * radius * radius * spec.richness * grade);
    out.push({
      idx,
      // Rotation about +X by the tilt, which maps the field's +Y onto the planet's spin axis.
      pos: spec.tilt === 0 ? pos : [pos[0], pos[1] * cosTilt - pos[2] * sinTilt, pos[1] * sinTilt + pos[2] * cosTilt],
      radius,
      variant,
      axis,
      spin,
      phase,
      ore,
      amount: Math.max(1, Math.min(spec.maxAmount, amount)),
    });
  }
  return out;
}
