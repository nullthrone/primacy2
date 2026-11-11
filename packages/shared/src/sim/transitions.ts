/**
 * Mode changes and placement. These are authoritative server decisions; the client only adopts
 * the resulting state from snapshots. All functions are deterministic given their arguments.
 */
import type { Vec3 } from '../math.ts';
import type { Rng } from '../prng.ts';
import type { SystemDef } from '../universe/types.ts';
import type { ShipState, ShipStats } from './types.ts';

const TODO = (name: string): never => {
  throw new Error(`${name} is not implemented`);
};

/** Barycentric position of a ship (anchor position plus offset). */
export function absolutePosition(s: ShipState, sys: SystemDef, t: number): Vec3 {
  return TODO('absolutePosition');
}

/** Re-expresses position and velocity relative to another anchor without changing the trajectory. */
export function reanchor(s: ShipState, sys: SystemDef, newAnchor: number, t: number): void {
  TODO('reanchor');
}

export type CruiseBlock = 'mode' | 'masslock' | 'fuel' | 'charging';

/**
 * Whether cruise can be engaged from normal flight. `masslock` when within MASS_LOCK_RADIUS of a
 * station, outpost or gate structure.
 */
export function canEngageCruise(
  s: ShipState,
  sys: SystemDef,
  t: number,
): { ok: true } | { ok: false; reason: CruiseBlock } {
  return TODO('canEngageCruise');
}

/** Normal -> Cruise. Re-anchors to the sphere-of-influence body and starts at CRUISE_MIN_SPEED along the nose. */
export function engageCruise(s: ShipState, sys: SystemDef, t: number): void {
  TODO('engageCruise');
}

/**
 * Cruise -> Normal. The new anchor is `site` when given and the ship is inside its frame radius,
 * otherwise `pickNormalAnchor`. The ship arrives at rest relative to the anchor, except that it
 * keeps 100 m/s along its nose. `emergency` is true when the speed was above CRUISE_SAFE_DROP_SPEED.
 */
export function disengageCruise(
  s: ShipState,
  sys: SystemDef,
  t: number,
  site?: number,
): { anchor: number; emergency: boolean } {
  return TODO('disengageCruise');
}

/** Places a ship in normal flight at rest `distance` metres from a site, nose toward it. */
export function placeAtSite(s: ShipState, sys: SystemDef, siteId: number, t: number, rng: Rng, distance: number): void {
  TODO('placeAtSite');
}

/**
 * Places a ship arriving from a fold jump: in cruise near the primary at
 * max(FOLD_ARRIVAL_RADII * radius, FOLD_ARRIVAL_MIN) (for compact objects, far enough that gravity
 * is survivable), on the side facing `fromDir` (unit vector from the destination toward the
 * origin system, or null for a random side), nose pointing away from the primary, throttle zero.
 */
export function placeAtFoldArrival(
  s: ShipState,
  sys: SystemDef,
  t: number,
  fromDir: Readonly<Vec3> | null,
  rng: Rng,
): void {
  TODO('placeAtFoldArrival');
}

/** Fuel in tonnes for a fold jump; see FOLD_FUEL_BASE and FOLD_FUEL_PER_LY. Infinity when out of range. */
export function foldFuelCost(distanceLy: number, stats: ShipStats): number {
  return TODO('foldFuelCost');
}
