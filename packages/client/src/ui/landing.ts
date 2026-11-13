/**
 * What the HUD works out for flight near the ground: the landing cues against the shared limits,
 * whether a landing is near, whether the body pulls harder than the vertical thrusters push,
 * where a cruise drop for a ground base makes sense, and which notices have a translation.
 * No interface code in here, so that the rules can be tested without a browser.
 */
import {
  G, LAND_MAX_SIDE, LAND_MAX_SINK, LAND_MAX_SLOPE_DEG, LAND_MAX_TILT_DEG, engineMul, upOf, v3,
  type Quat, type Vec3,
} from '@primacy2/shared';
import type { StringKey } from '../i18n/en.ts';

/** Below this height the landing cues show whatever the ship is doing, metres. */
export const LANDING_CUE_HEIGHT = 50;
/** Higher up they show once the ground is this many seconds away at the present sink rate. */
export const LANDING_CUE_SECONDS = 15;
/**
 * Farthest a ground base may be for the HUD to suggest leaving cruise for it, metres. From there
 * the slowest hull needs about nine minutes of normal flight, the fastest five.
 */
export const BASE_DROP_RANGE = 100_000;

/** One landing limit: the present value, the most a landing allows, and whether it is exceeded. */
export interface LandingCue {
  value: number;
  limit: number;
  over: boolean;
}

export interface LandingCues {
  /** Speed into the ground along its normal, m/s; zero when moving away from it. */
  sink: LandingCue;
  /** Speed along the ground in any direction, m/s. */
  side: LandingCue;
  /** Slope of the ground under the ship, degrees. */
  slope: LandingCue;
  /** Angle between the ship's up axis and the ground normal, degrees. */
  tilt: LandingCue;
  /** True when a touchdown now would be a collision instead of a landing. */
  over: boolean;
}

const cue = (value: number, limit: number): LandingCue => ({ value, limit, over: value > limit });
const DEG = 180 / Math.PI;

/**
 * The four conditions of the shared landing check for a touchdown at this moment, measured the
 * way the simulation measures them: velocity split along the ground normal, the slope under the
 * ship, and the ship's up axis against the normal. `vel`, `rot` and `normal` must be in the same
 * axes (the frame view gives all three in system axes); `slope` is in radians.
 */
export function landingCues(vel: Readonly<Vec3>, rot: Readonly<Quat>, normal: Readonly<Vec3>, slope: number): LandingCues {
  const vn = v3.dot(vel, normal);
  const along = v3.len([vel[0] - vn * normal[0], vel[1] - vn * normal[1], vel[2] - vn * normal[2]]);
  // Rounding can put the cosine a hair outside -1..1, where the arc cosine is not a number.
  const upright = Math.min(1, Math.max(-1, v3.dot(upOf(rot), normal)));
  const sink = cue(vn < 0 ? -vn : 0, LAND_MAX_SINK);
  const side = cue(along, LAND_MAX_SIDE);
  const steep = cue(slope * DEG, LAND_MAX_SLOPE_DEG);
  const tilt = cue(Math.acos(upright) * DEG, LAND_MAX_TILT_DEG);
  return { sink, side, slope: steep, tilt, over: sink.over || side.over || steep.over || tilt.over };
}

/**
 * Whether a touchdown is close enough for the landing cues: the ship is very low, or it is
 * sinking and would reach the ground within LANDING_CUE_SECONDS. A ship passing high over the
 * ground or climbing away is left alone.
 */
export function landingNear(height: number, verticalSpeed: number): boolean {
  if (height < LANDING_CUE_HEIGHT) return true;
  return verticalSpeed < 0 && height < -verticalSpeed * LANDING_CUE_SECONDS;
}

/**
 * Surface gravity of a body against what the vertical thrusters of a hull give at a power
 * setting, both in m/s^2. `short` says the thrusters alone cannot hold the ship up there: with
 * flight assist it sinks, and it comes down unless the pilot points the main drive at the ground.
 */
export function liftBalance(
  body: { mass: number; radius: number }, stats: { accelVert: number }, pips: number,
): { gravity: number; lift: number; short: boolean } {
  const gravity = (G * body.mass) / (body.radius * body.radius);
  const lift = stats.accelVert * engineMul(pips);
  return { gravity, lift, short: gravity > lift };
}

/**
 * Whether leaving cruise here is a sensible way to a ground base. `ship` and `pad` are in the
 * body-fixed axes of the base's body, metres from its centre; `enter` is the distance from the
 * centre below which normal flight is in the surface frame. Three conditions:
 *  - the ship is below `enter`, so it leaves cruise in the frame that turns with the ground and
 *    the base stays where it is;
 *  - the ship is above the horizon of the pad, so the base is in sight and not behind the body;
 *  - the base is within BASE_DROP_RANGE.
 */
export function baseDropHere(ship: Readonly<Vec3>, pad: Readonly<Vec3>, enter: number): boolean {
  if (v3.len(ship) >= enter) return false;
  const toShip = v3.sub(ship, pad);
  if (v3.len(toShip) > BASE_DROP_RANGE) return false;
  return v3.dot(toShip, pad) >= 0;
}

/** Notices of the server that the HUD shows in the pilot's language, by notice code. */
const NOTICE_BY_CODE: Record<string, StringKey> = {
  cruise_ceiling: 'notice.cruiseCeiling',
  cruise_ground: 'notice.cruiseGround',
  cruise_masslock: 'notice.cruiseMasslock',
  charge_landed: 'notice.chargeLanded',
  crash: 'notice.crash',
};
/**
 * Refused commands arrive as the notice `refused` with nothing but the server's English
 * sentence, so these are matched by that sentence. A sentence the server changes falls back to
 * being shown as it came.
 */
const NOTICE_BY_TEXT: Record<string, StringKey> = {
  'Lift off first.': 'notice.liftOffFirst',
  'Too close to the ground: climb above the cruise ceiling.': 'notice.cruiseGround',
  'Mass-locked: move away from the structure.': 'notice.cruiseMasslock',
  'No base here.': 'notice.noBase',
  'Too far from the base.': 'notice.baseTooFar',
};

/** The translation of a notice, or null when the HUD has to show the server's own text. */
export function noticeKey(code: string, text: string): StringKey | null {
  if (Object.hasOwn(NOTICE_BY_CODE, code)) return NOTICE_BY_CODE[code]!;
  if (code === 'refused' && Object.hasOwn(NOTICE_BY_TEXT, text)) return NOTICE_BY_TEXT[text]!;
  return null;
}
