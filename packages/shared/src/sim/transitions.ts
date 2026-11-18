/**
 * Mode changes and placement. These are authoritative server decisions; the client only adopts
 * the resulting state from snapshots. All functions are deterministic given their arguments.
 */
import {
  CRUISE_EXIT_SPEED,
  CRUISE_MIN_SPEED,
  CRUISE_SAFE_DROP_SPEED,
  FOLD_ARRIVAL_MAX_HEAT,
  FOLD_ARRIVAL_MIN,
  FOLD_ARRIVAL_RADII,
  FOLD_FUEL_BASE,
  FOLD_FUEL_PER_LY,
  G,
  HEAT_FLUX_K,
  MASS_LOCK_RADIUS,
} from '../constants.ts';
import { forwardOf, quat, v3, type Vec3 } from '../math.ts';
import type { Rng } from '../prng.ts';
import {
  anchorState, findSite, groundSiteRotation, isSurfaceAnchor, isValidAnchor, pickCruiseAnchor, pickNormalAnchor, surfaceAnchor,
} from '../universe/orbits.ts';
import { systemSurfaces } from '../universe/surface.ts';
import type { SystemDef } from '../universe/types.ts';
import { absolutePosition, reanchor } from './frames.ts';
import { buildStepEnv, cruiseSpeedFloor } from './ship.ts';
import { ChargeKind, FlightMode, type ShipState, type ShipStats } from './types.ts';

// These lived in this file before frames could turn; they are still offered from here.
export { CRUISE_EXIT_SPEED } from '../constants.ts';
export { absolutePosition, reanchor } from './frames.ts';
/**
 * Fold arrivals at a compact primary are placed where its pull is at most this (m/s^2), so that
 * even the weakest hull can hold position if it drops out of cruise there.
 */
export const FOLD_ARRIVAL_MAX_GRAVITY = 5;

const setVec = (out: Vec3, a: Readonly<Vec3>): void => {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
};

/** Clears everything a freshly placed ship must not carry over: spin, pending aim, drive charge. */
function settle(s: ShipState): void {
  setVec(s.angVel, [0, 0, 0]);
  s.aim[0] = 0;
  s.aim[1] = 0;
  s.charge = 0;
  s.chargeKind = ChargeKind.None;
}

/**
 * True when the ship is within MASS_LOCK_RADIUS (centre distance) of a station, outpost, gate or
 * ground base. Unlike `canEngageCruise` this ignores mode, fuel and charge state, so the server
 * can use it to re-check the mass lock at the moment a cruise charge completes.
 */
export function isMassLocked(s: ShipState, sys: SystemDef, t: number): boolean {
  let abs: Vec3 | null = null;
  for (const site of sys.sites) {
    if (site.kind !== 'station' && site.kind !== 'outpost' && site.kind !== 'gate' && site.kind !== 'base') continue;
    let d: number;
    if (site.id === s.anchor) {
      d = v3.len(s.pos);
    } else if (site.ground && s.anchor === surfaceAnchor(site.ground.body)) {
      // Ship and pad are in the same surface frame, where the pad does not move.
      d = v3.dist(s.pos, site.ground.pos);
    } else {
      abs ??= absolutePosition(s, sys, t);
      d = v3.dist(abs, anchorState(sys, site.id, t).pos);
    }
    if (d < MASS_LOCK_RADIUS) return true;
  }
  return false;
}

/**
 * The landable body whose cruise ceiling the ship is below (the highest possible ground plus
 * CRUISE_CEILING_MARGIN), or -1. Cruise cannot be engaged there and ends there.
 */
export function bodyBelowCeiling(s: ShipState, sys: SystemDef, t: number): number {
  const surfaces = systemSurfaces(sys);
  if (isSurfaceAnchor(s.anchor)) {
    // In a surface frame the ship's offset is its position from the body centre.
    const surface = surfaces[s.anchor - surfaceAnchor(0)];
    return surface && v3.lenSq(s.pos) < surface.ceiling * surface.ceiling ? surface.body : -1;
  }
  let abs: Vec3 | null = null;
  for (const surface of surfaces) {
    if (!surface) continue;
    abs ??= absolutePosition(s, sys, t);
    if (v3.distSq(abs, anchorState(sys, surface.body, t).pos) < surface.ceiling * surface.ceiling) return surface.body;
  }
  return -1;
}

export type CruiseBlock = 'mode' | 'masslock' | 'fuel' | 'charging' | 'ground';

/**
 * Whether cruise can be engaged from normal flight. `masslock` when within MASS_LOCK_RADIUS of a
 * station, outpost, gate or ground base; `ground` when below the cruise ceiling of a landable body.
 *
 * This is the gate for a pilot's request to start charging: it answers `charging` while any
 * cruise or fold charge is already in progress. Do not call it again when the charge completes
 * (it would answer `charging`); use `isMassLocked` for a re-check at that point.
 * Reasons are checked in the order mode, charging, fuel, masslock, ground.
 */
export function canEngageCruise(
  s: ShipState,
  sys: SystemDef,
  t: number,
): { ok: true } | { ok: false; reason: CruiseBlock } {
  if (s.mode !== FlightMode.Normal) return { ok: false, reason: 'mode' };
  if (s.chargeKind !== ChargeKind.None) return { ok: false, reason: 'charging' };
  if (!(s.fuel > 0)) return { ok: false, reason: 'fuel' };
  if (isMassLocked(s, sys, t)) return { ok: false, reason: 'masslock' };
  if (bodyBelowCeiling(s, sys, t) >= 0) return { ok: false, reason: 'ground' };
  return { ok: true };
}

/**
 * Normal -> Cruise. Re-anchors to the sphere-of-influence body and starts along the nose at the
 * lowest cruise speed there: CRUISE_MIN_SPEED, or the local limit close above a landable body.
 */
export function engageCruise(s: ShipState, sys: SystemDef, t: number): void {
  const abs = absolutePosition(s, sys, t);
  reanchor(s, sys, pickCruiseAnchor(sys, abs, t), t);
  s.mode = FlightMode.Cruise;
  s.cruiseSpeed = cruiseSpeedFloor(buildStepEnv(sys, s.anchor, t), s.pos);
  setVec(s.vel, v3.scale(forwardOf(s.rot), s.cruiseSpeed));
  s.charge = 0;
  s.chargeKind = ChargeKind.None;
}

/**
 * Cruise -> Normal. The new anchor is `site` when given and the ship is inside its frame radius,
 * otherwise `pickNormalAnchor`; close above a landable body it is always that body's surface
 * frame (see `pickNormalAnchor`). The ship arrives at rest relative to the anchor (in a surface
 * frame: relative to the ground), except that it keeps 100 m/s along its nose. `emergency` is
 * true when the speed was above CRUISE_SAFE_DROP_SPEED.
 */
export function disengageCruise(
  s: ShipState,
  sys: SystemDef,
  t: number,
  site?: number,
): { anchor: number; emergency: boolean } {
  const emergency = s.cruiseSpeed > CRUISE_SAFE_DROP_SPEED;
  const abs = absolutePosition(s, sys, t);
  let anchor = pickNormalAnchor(sys, abs, t);
  if (site !== undefined && !isSurfaceAnchor(anchor)) {
    const def = findSite(sys, site);
    if (def && !def.ground && v3.dist(abs, anchorState(sys, def.id, t).pos) < def.frameRadius) anchor = def.id;
  }
  reanchor(s, sys, anchor, t);
  s.mode = FlightMode.Normal;
  s.cruiseSpeed = 0;
  setVec(s.vel, v3.scale(forwardOf(s.rot), CRUISE_EXIT_SPEED));
  return { anchor, emergency };
}

/** A ship placed at a ground site stands off its centre line by at most this many metres. */
const GROUND_PLACE_SPREAD = 150;

/**
 * Places a ship in normal flight at rest `distance` metres from a site, nose toward it.
 * The side is chosen by `rng`. Body anchors are accepted too (distance from the centre).
 *
 * At a ground site the ship is placed in the surface frame of the body instead: `distance`
 * metres from the centre of the pad, above it and a little to one side (chosen by `rng`), at
 * rest relative to the ground, level, on a heading chosen by `rng`.
 * Throws on an unknown anchor id.
 */
export function placeAtSite(s: ShipState, sys: SystemDef, siteId: number, t: number, rng: Rng, distance: number): void {
  if (!isValidAnchor(sys, siteId)) throw new Error(`unknown anchor ${siteId}`);
  const d = Number.isFinite(distance) && distance > 0 ? distance : 0;
  const site = findSite(sys, siteId);
  s.mode = FlightMode.Normal;
  setVec(s.vel, [0, 0, 0]);
  s.cruiseSpeed = 0;
  s.throttle = 0;
  settle(s);
  if (site?.ground) {
    // The site's own axes are +Y up along the pad normal and -Z toward the body's north.
    const pad = groundSiteRotation(site);
    const heading = rng.range(0, 2 * Math.PI);
    const bearing = rng.range(0, 2 * Math.PI);
    const aside = Math.min(GROUND_PLACE_SPREAD, 0.5 * d) * Math.sqrt(rng.float());
    const local: Vec3 = [aside * Math.cos(bearing), Math.sqrt(d * d - aside * aside), aside * Math.sin(bearing)];
    s.anchor = surfaceAnchor(site.ground.body);
    setVec(s.pos, v3.add(site.ground.pos, quat.rotate(pad, local)));
    s.rot = quat.normalize(quat.mul(pad, quat.fromAxisAngle([0, 1, 0], heading)));
    return;
  }
  const dir = rng.unitVector();
  s.anchor = siteId;
  setVec(s.pos, v3.scale(dir, d));
  s.rot = quat.lookRotation(v3.neg(dir));
}

/**
 * Distance (m) from the primary at which fold arrivals are placed:
 * max(FOLD_ARRIVAL_RADII * radius, FOLD_ARRIVAL_MIN), and for a compact primary at least as far
 * out as its pull GM / (r - rs)^2 takes to drop to FOLD_ARRIVAL_MAX_GRAVITY.
 */
export function foldArrivalDistance(sys: SystemDef): number {
  const primary = sys.bodies[0];
  if (!primary) return FOLD_ARRIVAL_MIN;
  let d = Math.max(FOLD_ARRIVAL_RADII * primary.radius, FOLD_ARRIVAL_MIN);
  const rs = primary.rs ?? 0;
  if (rs > 0) d = Math.max(d, rs + Math.sqrt((G * primary.mass) / FOLD_ARRIVAL_MAX_GRAVITY));
  // Hot, luminous stars would cook a small hull at 14 radii: move out until the heating is bearable.
  const lum = primary.lum ?? 0;
  if (lum > 0) d = Math.max(d, (HEAT_FLUX_K * Math.sqrt(lum / (4 * Math.PI))) / FOLD_ARRIVAL_MAX_HEAT);
  return d;
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
  let dir: Vec3 | null = null;
  if (fromDir && v3.isFinite(fromDir)) {
    const n = v3.normalize(fromDir);
    if (v3.lenSq(n) > 0) dir = n;
  }
  dir ??= rng.unitVector();

  // The primary rests at the barycentre, so this is already a barycentric position.
  const abs = v3.scale(dir, foldArrivalDistance(sys));
  const anchor = pickCruiseAnchor(sys, abs, t);
  s.mode = FlightMode.Cruise;
  s.anchor = anchor;
  setVec(s.pos, v3.sub(abs, anchorState(sys, anchor, t).pos));
  s.rot = quat.lookRotation(dir);
  s.throttle = 0;
  s.cruiseSpeed = CRUISE_MIN_SPEED;
  setVec(s.vel, v3.scale(forwardOf(s.rot), s.cruiseSpeed));
  settle(s);
}

/** Fuel in tonnes for a fold jump; see FOLD_FUEL_BASE and FOLD_FUEL_PER_LY. Infinity when out of range. */
export function foldFuelCost(distanceLy: number, stats: ShipStats): number {
  const range = stats.jumpRange;
  if (!(range > 0) || !(distanceLy <= range)) return Infinity;
  const d = Math.max(0, distanceLy);
  return FOLD_FUEL_BASE + FOLD_FUEL_PER_LY * d * (d / range);
}
