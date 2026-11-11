/**
 * Mode changes and placement. These are authoritative server decisions; the client only adopts
 * the resulting state from snapshots. All functions are deterministic given their arguments.
 */
import {
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
import { anchorState, findSite, isValidAnchor, pickCruiseAnchor, pickNormalAnchor } from '../universe/orbits.ts';
import type { SystemDef } from '../universe/types.ts';
import { ChargeKind, FlightMode, type ShipState, type ShipStats } from './types.ts';

/** Speed along the nose that a ship keeps when it drops out of cruise, m/s. */
export const CRUISE_EXIT_SPEED = 100;
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

/** Barycentric position of a ship (anchor position plus offset). */
export function absolutePosition(s: ShipState, sys: SystemDef, t: number): Vec3 {
  // A ship in a fold tunnel has no anchor; its offset is returned unchanged.
  if (s.anchor < 0) return v3.clone(s.pos);
  return v3.add(anchorState(sys, s.anchor, t).pos, s.pos);
}

/** Re-expresses position and velocity relative to another anchor without changing the trajectory. */
export function reanchor(s: ShipState, sys: SystemDef, newAnchor: number, t: number): void {
  if (newAnchor === s.anchor) return;
  const from = anchorState(sys, s.anchor, t);
  const to = anchorState(sys, newAnchor, t);
  // The anchor difference is formed first so the small ship offset is not lost in the large sum.
  v3.addScaledIn(s.pos, v3.sub(from.pos, to.pos), 1);
  v3.addScaledIn(s.vel, v3.sub(from.vel, to.vel), 1);
  s.anchor = newAnchor;
}

/**
 * True when the ship is within MASS_LOCK_RADIUS (centre distance) of a station, outpost or gate.
 * Unlike `canEngageCruise` this ignores mode, fuel and charge state, so the server can use it to
 * re-check the mass lock at the moment a cruise charge completes.
 */
export function isMassLocked(s: ShipState, sys: SystemDef, t: number): boolean {
  let abs: Vec3 | null = null;
  for (const site of sys.sites) {
    if (site.kind !== 'station' && site.kind !== 'outpost' && site.kind !== 'gate') continue;
    let d: number;
    if (site.id === s.anchor) {
      d = v3.len(s.pos);
    } else {
      abs ??= absolutePosition(s, sys, t);
      d = v3.dist(abs, anchorState(sys, site.id, t).pos);
    }
    if (d < MASS_LOCK_RADIUS) return true;
  }
  return false;
}

export type CruiseBlock = 'mode' | 'masslock' | 'fuel' | 'charging';

/**
 * Whether cruise can be engaged from normal flight. `masslock` when within MASS_LOCK_RADIUS of a
 * station, outpost or gate structure.
 *
 * This is the gate for a pilot's request to start charging: it answers `charging` while any
 * cruise or fold charge is already in progress. Do not call it again when the charge completes
 * (it would answer `charging`); use `isMassLocked` for a re-check at that point.
 * Reasons are checked in the order mode, charging, fuel, masslock.
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
  return { ok: true };
}

/** Normal -> Cruise. Re-anchors to the sphere-of-influence body and starts at CRUISE_MIN_SPEED along the nose. */
export function engageCruise(s: ShipState, sys: SystemDef, t: number): void {
  const abs = absolutePosition(s, sys, t);
  reanchor(s, sys, pickCruiseAnchor(sys, abs, t), t);
  s.mode = FlightMode.Cruise;
  s.cruiseSpeed = CRUISE_MIN_SPEED;
  setVec(s.vel, v3.scale(forwardOf(s.rot), s.cruiseSpeed));
  s.charge = 0;
  s.chargeKind = ChargeKind.None;
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
  const emergency = s.cruiseSpeed > CRUISE_SAFE_DROP_SPEED;
  const abs = absolutePosition(s, sys, t);
  let anchor = -1;
  if (site !== undefined) {
    const def = findSite(sys, site);
    if (def && v3.dist(abs, anchorState(sys, def.id, t).pos) < def.frameRadius) anchor = def.id;
  }
  if (anchor < 0) anchor = pickNormalAnchor(sys, abs, t);
  reanchor(s, sys, anchor, t);
  s.mode = FlightMode.Normal;
  s.cruiseSpeed = 0;
  setVec(s.vel, v3.scale(forwardOf(s.rot), CRUISE_EXIT_SPEED));
  return { anchor, emergency };
}

/**
 * Places a ship in normal flight at rest `distance` metres from a site, nose toward it.
 * The side is chosen by `rng`. Body anchors are accepted too (distance from the centre).
 * Throws on an unknown anchor id.
 */
export function placeAtSite(s: ShipState, sys: SystemDef, siteId: number, t: number, rng: Rng, distance: number): void {
  if (!isValidAnchor(sys, siteId)) throw new Error(`unknown anchor ${siteId}`);
  const dir = rng.unitVector();
  const d = Number.isFinite(distance) && distance > 0 ? distance : 0;
  s.mode = FlightMode.Normal;
  s.anchor = siteId;
  setVec(s.pos, v3.scale(dir, d));
  setVec(s.vel, [0, 0, 0]);
  s.rot = quat.lookRotation(v3.neg(dir));
  s.cruiseSpeed = 0;
  s.throttle = 0;
  settle(s);
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
