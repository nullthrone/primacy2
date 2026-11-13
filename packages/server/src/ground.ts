/**
 * What the server does at the ground of landable bodies beyond the shared flight step: turning a
 * hard touchdown into hull damage, the colliders of ground bases, and finding where a shot or a
 * falling object meets the terrain. Everything here works in the surface frame of a body
 * (body-fixed axes, origin at the body centre).
 */
import {
  FlightMode,
  GROUND_BASE_STRUCTURE,
  MASS_LOCK_RADIUS,
  SURFACE_ID_BASE,
  anchorBody,
  bodySurface,
  collideStructure,
  computeShipStats,
  groundAltitude,
  groundSiteRotation,
  isSurfaceAnchor,
  quat,
  starterLoadout,
  v3,
  type BodySurface,
  type Contact,
  type Quat,
  type ShipState,
  type ShipStats,
  type SiteDef,
  type StructureDef,
  type SystemDef,
  type Vec3,
} from '@primacy2/shared';

/** The ground of a surface zone, or null when the zone is not the surface frame of a landable body. */
export function zoneSurface(def: SystemDef, zone: number): BodySurface | null {
  return isSurfaceAnchor(zone) ? bodySurface(def, zone - SURFACE_ID_BASE) : null;
}

/** How far from standing a saved landed ship may be and still be put back as it stands, metres. */
const RESEAT_TOLERANCE = 0.5;

/**
 * A ship saved standing on the ground comes back standing on the ground as it is now. A landed ship
 * never looks at the terrain again, so one saved at a height the terrain no longer has (a pad was
 * added, the generator changed) would stay below the ground or hang above it for good. A ship that
 * is not within RESEAT_TOLERANCE of standing is in flight again, at rest: raised onto the ground
 * if it was under it, and left to fall if it was above it.
 */
export function reseatLanded(state: ShipState, def: SystemDef, belly: number): void {
  if (state.mode !== FlightMode.Landed) return;
  const surface = isSurfaceAnchor(state.anchor) ? bodySurface(def, anchorBody(state.anchor)) : null;
  const altitude = surface ? groundAltitude(surface, state.pos) : NaN;
  if (Math.abs(altitude - belly) <= RESEAT_TOLERANCE) return;
  state.mode = FlightMode.Normal;
  state.vel = [0, 0, 0];
  state.angVel = [0, 0, 0];
  const r = v3.len(state.pos);
  if (surface && altitude < belly && r > 0) state.pos = v3.scale(state.pos, (r + (belly - altitude) + 1) / r);
}

// ---------------------------------------------------------------------------------------------
// Hard landings
// ---------------------------------------------------------------------------------------------

/** Impact speed over the gentle limits (m/s) at which the reference hull loses IMPACT_REF_FRACTION of its hull. */
export const IMPACT_REF_SPEED = 10;
export const IMPACT_REF_FRACTION = 0.25;
/** Damage grows with the impact speed to this power, so 25 m/s over the limits destroys the reference hull. */
export const IMPACT_EXPONENT = 1.5;
/** Bounds of the factor by which a hull that is heavy for its strength takes more damage. */
export const IMPACT_SCALE_MIN = 0.7;
export const IMPACT_SCALE_MAX = 1.6;
/**
 * What a ship has paid for earlier hard contacts wears off with this time constant, seconds. A
 * contact is charged only for what it adds to what is still remembered, so scraping along (a long
 * run of contacts that grow weaker) is paid for once, while a ship that goes on slamming into the
 * ground pays again as the memory fades: after half a second 61 % of a slam is still remembered.
 */
export const IMPACT_EPISODE = 1;

/** Kilograms per hull point of the stock Wisp, the hull the impact rule is stated for. */
const REF_MASS_PER_HULL = ((): number => {
  const wisp = computeShipStats(starterLoadout('wisp'));
  return wisp.mass / wisp.hullMax;
})();

/**
 * Share of its full hull that a ship loses when it hits the ground `impact` m/s harder than a
 * landing allows (`StepEnv.impact`): 0.25 * (impact / 10)^1.5 for the stock Wisp, which is a
 * quarter of the hull at 10 m/s over and all of it at about 25 m/s over. A hull that carries more
 * mass per hull point hits harder for its strength: the share is multiplied by the cube root of
 * its mass per hull point relative to the Wisp's, between 0.7 and 1.6 (about 1.5 for a Drover,
 * 1.3 for a Bulwark, less with armour plating).
 */
export function impactFraction(stats: Pick<ShipStats, 'mass' | 'hullMax'>, impact: number): number {
  if (!(impact > 0) || !(stats.hullMax > 0)) return 0;
  const heavy = Math.cbrt(stats.mass / stats.hullMax / REF_MASS_PER_HULL);
  const scale = Math.min(IMPACT_SCALE_MAX, Math.max(IMPACT_SCALE_MIN, heavy));
  return IMPACT_REF_FRACTION * Math.pow(impact / IMPACT_REF_SPEED, IMPACT_EXPONENT) * scale;
}

// ---------------------------------------------------------------------------------------------
// Ground bases
// ---------------------------------------------------------------------------------------------

/**
 * The shape ships collide with at a ground base: `GROUND_BASE_STRUCTURE` with every part carried
 * on downward to below the pad. Nothing can be underneath a building that stands on the ground,
 * so no part has an underside to push a ship out through: a ship pressed against the foot of the
 * block, or against the tower where it rises from the roof, is pushed sideways or upward, never
 * down into the block or the ground.
 */
export const BASE_COLLIDER: StructureDef = {
  ...GROUND_BASE_STRUCTURE,
  colliders: GROUND_BASE_STRUCTURE.colliders.map((c) =>
    c.kind === 'cylinder' ? { ...c, y0: -2 * GROUND_BASE_STRUCTURE.bound } : c),
};

/** A ground base as the collision and docking code needs it: where its pad is and how it is turned. */
export interface PadPose {
  site: SiteDef;
  /** Pad centre in the surface frame of its body. */
  pos: Vec3;
  /** Turns the site's own axes (+Y up along the pad normal) into the axes of the surface frame. */
  rot: Quat;
}

const padCache = new WeakMap<SiteDef, PadPose>();

/** The pose of a ground site's pad in the surface frame of its body. Constant, so it is kept per site. */
export function padPose(site: SiteDef): PadPose {
  let pose = padCache.get(site);
  if (!pose) {
    pose = { site, pos: v3.clone(site.ground!.pos), rot: groundSiteRotation(site) };
    padCache.set(site, pose);
  }
  return pose;
}

/**
 * Tests a ship's sphere at `pos` (surface frame) against the structure of a ground base. The
 * returned contact has its normal in the axes of the surface frame.
 */
export function collideBase(pad: PadPose, pos: Readonly<Vec3>, radius: number): Contact | null {
  const rel = v3.sub(pos, pad.pos);
  const reach = BASE_COLLIDER.bound + radius;
  if (v3.lenSq(rel) >= reach * reach) return null;
  const hit = collideStructure(BASE_COLLIDER, quat.unrotate(pad.rot, rel), radius);
  return hit ? { normal: quat.rotate(pad.rot, hit.normal), depth: hit.depth } : null;
}

/**
 * The ground base whose defences cover `pos` (surface frame of body `surface`): the nearest one
 * within MASS_LOCK_RADIUS of its pad, or null.
 */
export function baseCovering(surface: BodySurface, pos: Readonly<Vec3>): SiteDef | null {
  let best: SiteDef | null = null;
  let bestSq = MASS_LOCK_RADIUS * MASS_LOCK_RADIUS;
  for (const site of surface.sites) {
    const d = v3.distSq(pos, site.ground!.pos);
    if (d < bestSq) {
      bestSq = d;
      best = site;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Rays against the terrain
// ---------------------------------------------------------------------------------------------

/** A shot is followed over the terrain in at most this many steps. */
const RAY_STEPS = 48;
/** Step length: half the height above the ground, between these bounds in metres. */
const RAY_STEP_MIN = 4;
const RAY_STEP_MAX = 250;
/** Halvings that narrow down the point where the ray enters the ground. */
const RAY_REFINE = 6;

/**
 * Distance along a ray (`origin` and unit `dir` in the surface frame) at which it first meets the
 * ground, or -1 when it does not within `maxDist`. A ray that starts below ground hits at 0.
 *
 * The cost is bounded: nothing is sampled when the whole segment lies above the highest ground of
 * the body, and otherwise at most RAY_STEPS + RAY_REFINE terrain samples are taken. The ray is
 * walked in steps of half its height above the ground (4 to 250 m), so a ridge thinner than a
 * step that the ray only grazes can be missed, and a very long, very low shot is given up as a
 * miss when the steps run out.
 */
export function groundRay(surface: BodySurface, origin: Readonly<Vec3>, dir: Readonly<Vec3>, maxDist: number): number {
  if (!(maxDist > 0)) return -1;
  // The point of the segment nearest to the body centre decides whether the terrain matters at all.
  const along = -(origin[0] * dir[0] + origin[1] * dir[1] + origin[2] * dir[2]);
  const tc = along < 0 ? 0 : along > maxDist ? maxDist : along;
  const cx = origin[0] + dir[0] * tc;
  const cy = origin[1] + dir[1] * tc;
  const cz = origin[2] + dir[2] * tc;
  if (cx * cx + cy * cy + cz * cz > surface.top * surface.top) return -1;

  const p: Vec3 = [0, 0, 0];
  const heightAt = (t: number): number => {
    p[0] = origin[0] + dir[0] * t;
    p[1] = origin[1] + dir[1] * t;
    p[2] = origin[2] + dir[2] * t;
    return groundAltitude(surface, p);
  };
  let t = 0;
  let above = 0;
  for (let i = 0; i < RAY_STEPS; i++) {
    const h = heightAt(t);
    if (h <= 0) {
      if (i === 0) return 0;
      // Between `above` (over the ground) and `t` (under it): halve the stretch a few times.
      let lo = above;
      let hi = t;
      for (let k = 0; k < RAY_REFINE; k++) {
        const mid = 0.5 * (lo + hi);
        if (heightAt(mid) > 0) lo = mid;
        else hi = mid;
      }
      return hi;
    }
    if (t >= maxDist) return -1;
    above = t;
    const step = h * 0.5;
    t = Math.min(maxDist, t + (step < RAY_STEP_MIN ? RAY_STEP_MIN : step > RAY_STEP_MAX ? RAY_STEP_MAX : step));
  }
  return -1;
}
