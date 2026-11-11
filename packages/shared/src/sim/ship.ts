/**
 * The flight model. `stepShip` advances one ship by one tick and is the only place ship motion
 * is integrated; the server calls it authoritatively and the client calls it to predict.
 * It must be deterministic: same inputs, same outputs, no hidden state, no randomness.
 */
import type { Vec3 } from '../math.ts';
import type { SystemDef } from '../universe/types.ts';
import type { Hazards, ShipInput, ShipState, ShipStats, StepEnv } from './types.ts';

const TODO = (name: string): never => {
  throw new Error(`${name} is not implemented`);
};

/** A ship at rest at the origin of anchor 0 with full hull, shield, energy and fuel, flight assist on. */
export function newShipState(stats: ShipStats): ShipState {
  return TODO('newShipState');
}

/** Gathers the gravitating bodies of a system as seen from an anchor frame at time `t`. */
export function buildStepEnv(sys: SystemDef, anchorId: number, t: number): StepEnv {
  return TODO('buildStepEnv');
}

/**
 * Acceleration (m/s^2) felt at `pos` in the anchor frame: the sum over sources of
 * g(ship) - g(anchor), with the anchor body itself contributing its full gravity.
 * Compact objects (rs > 0) use GM / (r - rs)^2.
 */
export function gravityAt(env: StepEnv, pos: Readonly<Vec3>): Vec3 {
  return TODO('gravityAt');
}

/**
 * Time dilation factor in (0, 1]: sqrt(1 - rs/r) for the strongest compact source times
 * sqrt(1 - v^2/c^2). Never below 0.02.
 */
export function dilationAt(env: StepEnv, pos: Readonly<Vec3>, vel: Readonly<Vec3>): number {
  return TODO('dilationAt');
}

/**
 * Maximum cruise speed at `pos`: limited by the distance to the surface of every body,
 * clamped to [CRUISE_MIN_SPEED, stats.cruiseMax].
 */
export function cruiseSpeedLimit(env: StepEnv, pos: Readonly<Vec3>, stats: ShipStats): number {
  return TODO('cruiseSpeedLimit');
}

/** Environmental dangers at the position of a ship. Pure; the server turns the result into damage. */
export function hazardsAt(env: StepEnv, s: ShipState, stats: ShipStats): Hazards {
  return TODO('hazardsAt');
}

/**
 * Advances `s` in place by `dt` seconds of universe time.
 * Handles `Normal` and `Cruise` flight; in `Fold`, `Docked` and `Dead` only timers and regeneration run.
 */
export function stepShip(s: ShipState, input: Readonly<ShipInput>, stats: ShipStats, env: StepEnv, dt: number): void {
  TODO('stepShip');
}

/**
 * One full tick for a ship inside a system: builds the environment, steps the ship and, in cruise,
 * re-anchors it when it crosses into the sphere of influence of another body. Returns the
 * environment used (after any re-anchoring) so callers can evaluate hazards without rebuilding it.
 */
export function simulateShip(
  s: ShipState,
  input: Readonly<ShipInput>,
  stats: ShipStats,
  sys: SystemDef,
  t: number,
  dt: number,
): StepEnv {
  return TODO('simulateShip');
}
