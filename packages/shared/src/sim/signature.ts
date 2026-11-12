/**
 * Heat signature and detection. Every ship radiates; how brightly decides from how far another
 * ship's sensors pick it up. `shipSignature` is evaluated by `stepShip` every tick and stored in
 * `ShipState.sig`; `canDetect` is the one rule that the server's interest sets, NPC target
 * acquisition and missile seekers all use.
 */
import { FlightMode, type ShipState, type ShipStats } from './types.ts';

/** Hull radius of the reference ship whose idle signature is 1, metres. */
export const SIG_REF_RADIUS = 12;
/** Emission of a ship whose shields are down, relative to the same ship with shields up. */
export const SIG_SHIELDS_DOWN = 0.75;
/** Emission added at a heat level equal to the heat capacity. */
export const SIG_HEAT = 2;
/** The heat term stops growing at this multiple of the heat capacity. */
export const SIG_HEAT_LIMIT = 2;
/** Emission added by thrusters at the hull's rated forward acceleration. */
export const SIG_THRUST = 3;
/** Emission added while the boost burns. */
export const SIG_BOOST = 2;
/** Factor on the whole signature while running silent. */
export const SIG_SILENT = 0.08;
/** Signature of a ship in cruise: the drive is visible across the whole system. */
export const SIG_CRUISE = 1e20;

/** Fraction of the full shield charge that bleeds away per second while running silent. */
export const SILENT_SHIELD_DRAIN = 0.5;
/** Factor on the cooling rate while running silent: the radiators are closed. */
export const SILENT_COOLING = 0.1;
/**
 * Heat units per second, per unit of reactor output (`ShipStats.energyRegen`), that stay in the
 * hull while running silent. With the radiators open this waste heat is shed unnoticed; with
 * them closed it is what fills the heat capacity and puts a time limit on silent running.
 */
export const SILENT_REACTOR_HEAT = 0.3;

/** Inside this distance a ship is seen by eye whatever its signature, metres. */
export const VISUAL_RANGE = 1_500;
/** A contact already held is kept out to this multiple of the detection range, so it does not flicker at the edge. */
export const DETECT_HYSTERESIS = 1.1;

/**
 * Heat signature of a ship; 1 is a reference-sized ship idling with shields up.
 * `thrust` is the thruster output of the tick as a fraction of the rated forward acceleration,
 * `silent` whether the ship runs silent. A ship in cruise has `SIG_CRUISE`; a ship that is not
 * in space (docked, in a fold tunnel, destroyed) has 0.
 */
export function shipSignature(s: Readonly<ShipState>, stats: ShipStats, thrust: number, silent: boolean): number {
  if (s.mode === FlightMode.Cruise) return SIG_CRUISE;
  if (s.mode !== FlightMode.Normal) return 0;
  const heat = stats.heatCap > 0 ? Math.min(Math.max(s.heat / stats.heatCap, 0), SIG_HEAT_LIMIT) : 0;
  const emission = (s.shield > 0 ? 1 : SIG_SHIELDS_DOWN) + SIG_HEAT * heat + SIG_THRUST * thrust + (s.boost > 0 ? SIG_BOOST : 0);
  return (stats.radius / SIG_REF_RADIUS) * emission * (silent ? SIG_SILENT : 1);
}

/** Distance in metres out to which sensors of `sensorRange` pick up a signature. Never less than `VISUAL_RANGE`. */
export function detectionRange(observer: Pick<ShipStats, 'sensorRange'>, targetSig: number): number {
  const range = targetSig > 0 ? observer.sensorRange * Math.sqrt(targetSig) : 0;
  return range > VISUAL_RANGE ? range : VISUAL_RANGE;
}

/**
 * Whether an observer picks up a target with signature `targetSig` at `distance` metres.
 * Pass `known` for a contact the observer already holds: it is kept `DETECT_HYSTERESIS` farther out.
 */
export function canDetect(observer: Pick<ShipStats, 'sensorRange'>, distance: number, targetSig: number, known = false): boolean {
  const range = detectionRange(observer, targetSig);
  return distance <= (known ? range * DETECT_HYSTERESIS : range);
}
