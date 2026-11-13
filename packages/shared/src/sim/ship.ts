/**
 * The flight model. `stepShip` advances one ship by one tick and is the only place ship motion
 * is integrated; the server calls it authoritatively and the client calls it to predict.
 * It must be deterministic: same inputs, same outputs, no hidden state, no randomness.
 */
import {
  AIM_BUFFER_MAX,
  AIM_GAIN,
  BODY_EXCLUSION_FACTOR,
  BOOST_COOLDOWN,
  BOOST_DURATION,
  BOOST_ENERGY,
  C,
  COMPACT_KILL_FACTOR,
  CRUISE_CHARGE_TIME,
  CRUISE_EXIT_SPEED,
  CRUISE_FUEL_RATE,
  CRUISE_GROUND_MIN_SPEED,
  CRUISE_MIN_SPEED,
  CRUISE_PROXIMITY_K,
  CRUISE_TURN_FACTOR,
  FA_TAU,
  FOLD_CHARGE_TIME,
  G,
  GROUND_FRICTION,
  GROUND_RESTITUTION,
  HEAT_FLUX_K,
  LAND_MAX_SIDE,
  LAND_MAX_SINK,
  LIFTOFF_SPEED,
  LIFTOFF_THRUST,
  SCOOP_MAX_RADII,
  SITE_ID_BASE,
  SURFACE_ID_BASE,
} from '../constants.ts';
import { approach, clamp, forwardOf, quat, v3, type Quat, type Vec3 } from '../math.ts';
import {
  allBodyStates, anchorFrame, anchorState, bodyRotation, bodySpinRate, findSite, orbitState, pickCruiseAnchor, surfaceAnchor,
} from '../universe/orbits.ts';
import { systemSurfaces } from '../universe/surface.ts';
import { terrainHeight, terrainNormal } from '../universe/terrain.ts';
import type { SystemDef } from '../universe/types.ts';
import { reanchor } from './frames.ts';
import { DEFAULT_PIPS, engineMul, normalizePips, shieldRegenMul } from './power.ts';
import { SILENT_COOLING, SILENT_REACTOR_HEAT, SILENT_SHIELD_DRAIN, shipSignature } from './signature.ts';
import {
  Button,
  ChargeKind,
  FlightMode,
  type GravSource,
  type Hazards,
  type ShipInput,
  type ShipState,
  type ShipStats,
  type StepEnv,
} from './types.ts';

/** Ship speed relative to its anchor never exceeds this in normal flight, m/s. */
export const MAX_SHIP_SPEED = 0.999 * C;
/** Lower bound of the time dilation factor. */
export const MIN_DILATION = 0.02;

/** Sideways and vertical flight-assist speed as a fraction of the forward speed limit. */
const FA_STRAFE_FACTOR = 0.7;
/** Reverse flight-assist speed as a fraction of the forward speed limit. */
const FA_REVERSE_FACTOR = 0.6;
/** Cruise speed time constants in seconds: spooling up is slower than dropping speed. */
const CRUISE_TAU_UP = 2.0;
const CRUISE_TAU_DOWN = 0.6;
/**
 * The Paczynski-Wiita pull diverges at rs. Below this multiple of rs (or below the body radius,
 * whichever is larger) the pull falls off linearly to zero at the centre instead, which keeps
 * the acceleration finite and continuous everywhere. Ships are destroyed long before
 * (COMPACT_KILL_FACTOR), so this only has to be well behaved, not physical.
 */
const GRAVITY_INNER_RS = 1.5;
/** Pending aim smaller than this is treated as worked off, radians. */
const AIM_EPSILON = 1e-9;
/**
 * Steepest ground a ship can stand on, as rise over run: tan(LAND_MAX_SLOPE_DEG). Written as a
 * literal, not computed, because Math.tan is not required to round the same way in every engine
 * and a touchdown near the limit must be judged alike by the server and by every client.
 */
export const LAND_MAX_SLOPE = 0.36397023426620234;
/**
 * Smallest cosine of the angle between the ship's up axis and the ground normal at which it can
 * touch down: cos(LAND_MAX_TILT_DEG). A literal for the same reason as LAND_MAX_SLOPE.
 */
export const LAND_MIN_UPRIGHT = 0.8660254037844387;
/** The ground normal under a ship is measured over its footprint, but over at least this many metres. */
export const GROUND_BASELINE_MIN = 10;

const ORIGIN: Readonly<Vec3> = [0, 0, 0];

/**
 * A gravity source as built by `buildStepEnv`: `GravSource` plus whether a fuel scoop works in
 * the body's corona. `StepEnv.sources` is typed as `GravSource[]`; sources without the flag are
 * treated as not scoopable.
 */
export interface StepSource extends GravSource {
  scoopable: boolean;
}

/** Non-finite numbers (NaN, +-Infinity) become 0 so a malformed input cannot poison the state. */
const finite = (x: number): number => (Number.isFinite(x) ? x : 0);
const unit = (x: number): number => clamp(finite(x), -1, 1);

/** A ship at rest at the origin of anchor 0 with full hull, shield, energy and fuel, flight assist on. */
export function newShipState(stats: ShipStats): ShipState {
  const s: ShipState = {
    mode: FlightMode.Normal,
    anchor: 0,
    pos: [0, 0, 0],
    vel: [0, 0, 0],
    rot: [0, 0, 0, 1],
    angVel: [0, 0, 0],
    aim: [0, 0],
    fa: true,
    throttle: 0,
    cruiseSpeed: 0,
    boost: 0,
    boostCd: 0,
    energy: stats.energyMax,
    heat: 0,
    fuel: stats.fuelCap,
    shield: stats.shieldMax,
    hull: stats.hullMax,
    shieldDelay: 0,
    charge: 0,
    chargeKind: ChargeKind.None,
    dilation: 1,
    pips: DEFAULT_PIPS,
    sig: 0,
  };
  // A new ship is detectable at once, before its first tick.
  s.sig = shipSignature(s, stats, 0, false);
  return s;
}

/**
 * Gathers the gravitating bodies of a system as seen from an anchor frame at time `t`, with their
 * positions in the axes of that frame. For a surface anchor the environment also carries the
 * frame's angular velocity and the ground. The returned sources are `StepSource` objects.
 * Throws on an unknown anchor id.
 */
export function buildStepEnv(sys: SystemDef, anchorId: number, t: number): StepEnv {
  const states = allBodyStates(sys, t);
  const surfaces = systemSurfaces(sys);
  // The frame origin is a body position plus, for sites, the site's offset from its parent body.
  // Subtracting the body first keeps the parent's position relative to a site exact.
  let base: Readonly<Vec3>;
  let offset: Readonly<Vec3> | null = null;
  /** Turns frame axes into system axes; null for a frame that does not turn. */
  let rot: Quat | null = null;
  const env: StepEnv = { t, anchor: anchorId, sources: [] };
  // The body whose pull is felt in full: the one the frame is centred on.
  let centre = -1;
  if (anchorId < SURFACE_ID_BASE) {
    const st = states[anchorId];
    if (!st) throw new Error(`unknown anchor ${anchorId}`);
    base = st.pos;
    centre = anchorId;
  } else if (anchorId < SITE_ID_BASE) {
    const id = anchorId - SURFACE_ID_BASE;
    const body = sys.bodies[id];
    const surface = surfaces[id];
    if (!body || !surface) throw new Error(`unknown anchor ${anchorId}`);
    base = states[id]!.pos;
    centre = id;
    rot = bodyRotation(body, t);
    // The body-fixed +Y axis is the spin axis.
    env.omega = [0, bodySpinRate(body), 0];
    env.ground = { body: id, radius: surface.radius, top: surface.top, exit: surface.exit, terrain: surface.terrain };
    env.impact = 0;
  } else {
    const site = findSite(sys, anchorId);
    const parent = site ? states[site.orbit.parent] : undefined;
    if (!site || !parent) throw new Error(`unknown anchor ${anchorId}`);
    base = parent.pos;
    if (site.ground) {
      // A ground site is the anchor of docked ships only. Its frame is the pad, which turns with the body.
      const frame = anchorFrame(sys, anchorId, t);
      offset = v3.sub(frame.pos, parent.pos);
      rot = frame.rot;
      env.omega = quat.unrotate(frame.rot, frame.omega);
    } else {
      offset = orbitState(site.orbit, t).pos;
    }
  }
  for (let i = 0; i < sys.bodies.length; i++) {
    const b = sys.bodies[i]!;
    let pos = v3.sub(states[i]!.pos, base);
    if (offset) v3.addScaledIn(pos, offset, -1);
    if (rot) pos = quat.unrotate(rot, pos);
    const src: StepSource = {
      bodyId: i,
      mu: G * b.mass,
      pos,
      radius: b.radius,
      rs: b.rs ?? 0,
      isAnchor: i === centre,
      lum: b.lum ?? 0,
      scoopable: b.scoopable === true,
    };
    const surface = surfaces[i];
    if (surface) src.surface = surface;
    env.sources.push(src);
  }
  return env;
}

/** Magnitude (m/s^2) of the pull of `src` at centre distance `r` > 0 metres. Always finite. */
function pullMagnitude(src: Readonly<GravSource>, r: number): number {
  const inner = Math.max(src.radius, src.rs * GRAVITY_INNER_RS, 1);
  if (r >= inner) {
    const d = r - src.rs;
    return src.mu / (d * d);
  }
  const d = inner - src.rs;
  return (src.mu / (d * d)) * (r / inner);
}

/**
 * Adds `sign` times the pull of `src` on a point at `p` (anchor frame, metres) to `out` and
 * returns the unsigned magnitude of that pull in m/s^2.
 */
function addPull(out: Vec3, src: Readonly<GravSource>, p: Readonly<Vec3>, sign: number): number {
  const dx = src.pos[0] - p[0];
  const dy = src.pos[1] - p[1];
  const dz = src.pos[2] - p[2];
  const r = Math.hypot(dx, dy, dz);
  if (!(r > 0) || r === Infinity || !(src.mu > 0)) return 0;
  const g = pullMagnitude(src, r);
  const k = (sign * g) / r;
  out[0] += dx * k;
  out[1] += dy * k;
  out[2] += dz * k;
  return g;
}

/**
 * Acceleration (m/s^2) felt at `pos` in the anchor frame: the sum over sources of
 * g(ship) - g(anchor), with the anchor body itself contributing its full gravity.
 * Compact objects (rs > 0) use GM / (r - rs)^2.
 */
export function gravityAt(env: StepEnv, pos: Readonly<Vec3>): Vec3 {
  const out: Vec3 = [0, 0, 0];
  for (const src of env.sources) {
    // Each source's tidal difference is formed on its own before it is added to the total,
    // so a strong pull that cancels (a planet seen from a station) does not swamp the others.
    const d: Vec3 = [0, 0, 0];
    addPull(d, src, pos, 1);
    if (!src.isAnchor) addPull(d, src, ORIGIN, -1);
    out[0] += d[0];
    out[1] += d[1];
    out[2] += d[2];
  }
  return out;
}

/**
 * Adds to `out` what a frame turning at `omega` (rad/s, frame axes) makes a ship at `pos` moving
 * at `vel` feel: the Coriolis acceleration -2 omega x v and the centrifugal acceleration
 * -omega x (omega x r).
 */
function addFrameForces(out: Vec3, omega: Readonly<Vec3>, pos: Readonly<Vec3>, vel: Readonly<Vec3>): void {
  const wx = omega[0];
  const wy = omega[1];
  const wz = omega[2];
  out[0] -= 2 * (wy * vel[2] - wz * vel[1]);
  out[1] -= 2 * (wz * vel[0] - wx * vel[2]);
  out[2] -= 2 * (wx * vel[1] - wy * vel[0]);
  const w2 = wx * wx + wy * wy + wz * wz;
  const wr = wx * pos[0] + wy * pos[1] + wz * pos[2];
  out[0] += pos[0] * w2 - wx * wr;
  out[1] += pos[1] * w2 - wy * wr;
  out[2] += pos[2] * w2 - wz * wr;
}

/**
 * Acceleration (m/s^2) of a ship in free fall at `pos` with velocity `vel`, in the anchor frame:
 * `gravityAt`, and in a turning frame (a surface frame) the Coriolis and centrifugal terms as
 * well. This is what normal flight integrates and what flight assist cancels.
 */
export function accelerationAt(env: StepEnv, pos: Readonly<Vec3>, vel: Readonly<Vec3>): Vec3 {
  const a = gravityAt(env, pos);
  if (env.omega) addFrameForces(a, env.omega, pos, vel);
  return a;
}

/**
 * Time dilation factor in (0, 1]: sqrt(1 - rs/r) for the strongest compact source times
 * sqrt(1 - v^2/c^2). Never below 0.02.
 */
export function dilationAt(env: StepEnv, pos: Readonly<Vec3>, vel: Readonly<Vec3>): number {
  let grav = 1;
  for (const src of env.sources) {
    if (!(src.rs > 0)) continue;
    const r = v3.dist(pos, src.pos);
    const f = r > src.rs ? 1 - src.rs / r : 0;
    if (f < grav) grav = f;
  }
  const beta2 = v3.lenSq(vel) / (C * C);
  const kin = beta2 < 1 ? 1 - beta2 : 0;
  const d = Math.sqrt(grav * kin);
  return d > MIN_DILATION ? d : MIN_DILATION;
}

/** Radius (m) below which cruise speed is zero: the body surface, or the lethal radius of a compact object. */
const cruiseSurface = (src: Readonly<GravSource>): number =>
  src.rs > 0 ? Math.max(src.radius, src.rs * COMPACT_KILL_FACTOR) : src.radius;

/**
 * The cruise speed that landable bodies allow at `pos`: CRUISE_PROXIMITY_K times the height above
 * the nearest ceiling, and never less than CRUISE_GROUND_MIN_SPEED. Infinity without such a body.
 */
function groundCruiseLimit(env: StepEnv, pos: Readonly<Vec3>): number {
  let limit = Infinity;
  for (const src of env.sources) {
    if (!src.surface) continue;
    const l = CRUISE_PROXIMITY_K * Math.max(0, v3.dist(pos, src.pos) - src.surface.ceiling);
    if (l < limit) limit = l;
  }
  return limit > CRUISE_GROUND_MIN_SPEED ? limit : CRUISE_GROUND_MIN_SPEED;
}

/**
 * Maximum cruise speed at `pos`: limited by the distance to the surface of every body and clamped
 * to [CRUISE_MIN_SPEED, stats.cruiseMax]. A landable body limits by the height above its ceiling
 * instead and lets the limit fall to CRUISE_GROUND_MIN_SPEED, so a pilot can fly down in cruise.
 */
export function cruiseSpeedLimit(env: StepEnv, pos: Readonly<Vec3>, stats: ShipStats): number {
  let limit = stats.cruiseMax;
  for (const src of env.sources) {
    if (src.surface) continue;
    const l = CRUISE_PROXIMITY_K * Math.max(0, v3.dist(pos, src.pos) - cruiseSurface(src));
    if (l < limit) limit = l;
  }
  if (!(limit > CRUISE_MIN_SPEED)) limit = CRUISE_MIN_SPEED;
  const ground = groundCruiseLimit(env, pos);
  return ground < limit ? ground : limit;
}

/**
 * Lowest cruise speed at `pos`, the speed at zero throttle: CRUISE_MIN_SPEED, or what a landable
 * body allows there when that is less.
 */
export function cruiseSpeedFloor(env: StepEnv, pos: Readonly<Vec3>): number {
  const ground = groundCruiseLimit(env, pos);
  return ground < CRUISE_MIN_SPEED ? ground : CRUISE_MIN_SPEED;
}

/**
 * Radiant heating at `pos` in heat units per second: the sum over luminous sources of
 * HEAT_FLUX_K * sqrt(flux), flux = lum / (4 pi d^2) in W/m^2. Inside a star the surface flux applies.
 */
export function heatInfluxAt(env: StepEnv, pos: Readonly<Vec3>): number {
  let sum = 0;
  for (const src of env.sources) {
    if (!(src.lum > 0)) continue;
    const d = Math.max(v3.dist(pos, src.pos), src.radius, 1);
    sum += HEAT_FLUX_K * Math.sqrt(src.lum / (4 * Math.PI * d * d));
  }
  return sum;
}

/**
 * Environmental dangers at the position of a ship. Pure; the server turns the result into damage.
 * `gravity` is the pull of the bodies alone, without what a turning frame adds.
 */
export function hazardsAt(env: StepEnv, s: ShipState, stats: ShipStats): Hazards {
  let insideBody = -1;
  let lethal = false;
  let tidal = 0;
  let dominantBody = -1;
  let strongest = 0;
  const scratch: Vec3 = [0, 0, 0];
  for (const src of env.sources) {
    const r = v3.dist(s.pos, src.pos);
    // A landable body has no exclusion radius: its terrain is the limit, and `stepShip` enforces it.
    if (insideBody < 0 && !src.surface && r < src.radius * BODY_EXCLUSION_FACTOR) insideBody = src.bodyId;
    if (src.rs > 0 && r < src.rs * COMPACT_KILL_FACTOR) lethal = true;
    // Difference in pull between nose and tail of a hull 2 * radius long; the 1 m floor keeps it finite.
    const rt = Math.max(r, 1);
    const stretch = (2 * src.mu * (2 * stats.radius)) / (rt * rt * rt);
    if (stretch > tidal) tidal = stretch;
    const pull = addPull(scratch, src, s.pos, 1);
    if (pull > strongest) {
      strongest = pull;
      dominantBody = src.bodyId;
    }
  }
  return {
    insideBody,
    lethal,
    tidal,
    heatInflux: heatInfluxAt(env, s.pos),
    gravity: v3.len(gravityAt(env, s.pos)),
    dominantBody,
  };
}

/**
 * Turn rate (rad/s) that works off a pending aim error of `err` radians. The stopping term is the
 * fastest rate from which the ship can still come to rest on the aim point when it sheds
 * `angAccel * dts` per tick; it is the discrete-time form of sqrt(2 * angAccel * |err|) and never
 * larger than it. The rate is also capped so a single tick cannot turn past the aim point.
 */
function aimRate(err: number, limit: number, angAccel: number, dts: number): number {
  const e = Math.abs(err);
  if (!(e > 0)) return 0;
  const half = angAccel * dts * 0.5;
  const stop = Math.sqrt(2 * angAccel * e + half * half) - half;
  return Math.sign(err) * Math.min(limit, AIM_GAIN * e, stop, e / dts);
}

/**
 * Removes the angle turned this tick from a pending aim value without letting it change sign.
 * A remainder below AIM_EPSILON is dropped so the buffer ends at exactly zero instead of decaying forever.
 */
function consumeAim(aim: number, turned: number): number {
  const rest = aim > 0 ? clamp(aim - turned, 0, AIM_BUFFER_MAX) : aim < 0 ? clamp(aim - turned, -AIM_BUFFER_MAX, 0) : 0;
  return Math.abs(rest) < AIM_EPSILON ? 0 : rest;
}

/**
 * Assisted rotation: accumulates mouse aim, steers the angular velocity toward the rates that work
 * the aim buffer off, integrates the orientation and consumes the angle actually turned.
 * `turnScale` scales the hull's turn rate limits.
 */
function stepRotation(s: ShipState, input: Readonly<ShipInput>, stats: ShipStats, dts: number, turnScale: number): void {
  s.aim[0] = clamp(s.aim[0] + finite(input.aim[0]), -AIM_BUFFER_MAX, AIM_BUFFER_MAX);
  s.aim[1] = clamp(s.aim[1] + finite(input.aim[1]), -AIM_BUFFER_MAX, AIM_BUFFER_MAX);

  const yawRate = aimRate(s.aim[0], stats.turnYaw * turnScale, stats.angAccel, dts);
  const pitchRate = aimRate(s.aim[1], stats.turnPitch * turnScale, stats.angAccel, dts);
  const rollRate = unit(input.roll) * stats.turnRoll * turnScale;

  // Ship-local rotation vector: pitch up = +X, yaw right = -Y, roll right = -Z.
  // Adding 0 turns a negated zero rate (-0) into +0, so a ship at rest has a canonical state.
  const maxDelta = stats.angAccel * dts;
  s.angVel[0] = approach(s.angVel[0], pitchRate, maxDelta) + 0;
  s.angVel[1] = approach(s.angVel[1], -yawRate, maxDelta) + 0;
  s.angVel[2] = approach(s.angVel[2], -rollRate, maxDelta) + 0;

  const q = quat.integrate(s.rot, s.angVel, dts);
  s.rot[0] = q[0];
  s.rot[1] = q[1];
  s.rot[2] = q[2];
  s.rot[3] = q[3];

  s.aim[0] = consumeAim(s.aim[0], -s.angVel[1] * dts);
  s.aim[1] = consumeAim(s.aim[1], s.angVel[0] * dts);
}

/**
 * Normal flight: boost, thrust (flight assist or raw), gravity (in a surface frame with the
 * Coriolis and centrifugal terms), relativistic limits, integration.
 * Returns the thruster output of the tick as a fraction of the hull's rated forward acceleration
 * (above 1 with boost, extra engine power or several axes at once); it feeds the heat signature.
 */
function stepNormal(s: ShipState, input: Readonly<ShipInput>, stats: ShipStats, env: StepEnv, dts: number): number {
  if ((input.buttons & Button.Boost) !== 0 && s.boostCd <= 0 && s.energy >= BOOST_ENERGY) {
    s.energy -= BOOST_ENERGY;
    s.boost = BOOST_DURATION;
    s.boostCd = BOOST_COOLDOWN;
  }
  const boosting = s.boost > 0;
  // Power to the engines scales every thruster and the speeds the flight assist aims for.
  const eng = engineMul(s.pips);
  const k = (boosting ? stats.boostAccel : 1) * eng;

  // Everything a ship in free fall feels in this frame; flight assist cancels all of it.
  const g = accelerationAt(env, s.pos, s.vel);
  const brake = (input.buttons & Button.Brake) !== 0;
  const tx = unit(input.thrust[0]);
  const ty = unit(input.thrust[1]);
  const tz = unit(input.thrust[2]);

  // Commanded thrust acceleration in ship axes (m/s^2), before the per-axis thruster limits.
  let cmd: Vec3;
  if (s.fa) {
    const vmax = (boosting ? stats.boostSpeed : stats.maxSpeed) * eng;
    let want: Vec3 = [0, 0, 0];
    if (!brake) {
      const f = clamp(s.throttle + tz, -1, 1);
      want = [tx * FA_STRAFE_FACTOR * vmax, ty * FA_STRAFE_FACTOR * vmax, -Math.max(f, -FA_REVERSE_FACTOR) * vmax];
      const len = v3.len(want);
      if (len > vmax) want = v3.scale(want, vmax / len);
      want = quat.rotate(s.rot, want);
    }
    // A time constant shorter than the step would overshoot the commanded velocity.
    const tau = Math.max(FA_TAU, dts);
    cmd = quat.unrotate(s.rot, [
      (want[0] - s.vel[0]) / tau - g[0],
      (want[1] - s.vel[1]) / tau - g[1],
      (want[2] - s.vel[2]) / tau - g[2],
    ]);
  } else if (brake) {
    // Cancel the whole velocity this tick if the thrusters allow it; the limits below cut it down.
    cmd = quat.unrotate(s.rot, v3.scale(s.vel, -1 / dts));
  } else {
    cmd = [tx * stats.accelLat * k, ty * stats.accelVert * k, -tz * (tz >= 0 ? stats.accelFwd : stats.accelBack) * k];
  }
  cmd[0] = clamp(cmd[0], -stats.accelLat * k, stats.accelLat * k);
  cmd[1] = clamp(cmd[1], -stats.accelVert * k, stats.accelVert * k);
  // Forward is -Z: the main engines push toward -Z, the retro thrusters toward +Z.
  cmd[2] = clamp(cmd[2], -stats.accelFwd * k, stats.accelBack * k);

  // The same thrust changes the velocity less as the ship nears c: a = F / (m * gamma^3).
  const maxBeta2 = (MAX_SHIP_SPEED / C) * (MAX_SHIP_SPEED / C);
  const beta2 = Math.min(v3.lenSq(s.vel) / (C * C), maxBeta2);
  const invGamma3 = Math.pow(1 - beta2, 1.5);
  const thrust = quat.rotate(s.rot, cmd);

  // Semi-implicit Euler: velocity first, then position with the new velocity.
  s.vel[0] += (thrust[0] * invGamma3 + g[0]) * dts;
  s.vel[1] += (thrust[1] * invGamma3 + g[1]) * dts;
  s.vel[2] += (thrust[2] * invGamma3 + g[2]) * dts;
  const speed = v3.len(s.vel);
  if (speed > MAX_SHIP_SPEED) {
    const f = MAX_SHIP_SPEED / speed;
    s.vel[0] *= f;
    s.vel[1] *= f;
    s.vel[2] *= f;
  }
  s.pos[0] += s.vel[0] * dts;
  s.pos[1] += s.vel[1] * dts;
  s.pos[2] += s.vel[2] * dts;
  return stats.accelFwd > 0 ? v3.len(cmd) / stats.accelFwd : 0;
}

/** Cruise flight: speed follows the throttle under the proximity limit; gravity is ignored. */
function stepCruise(s: ShipState, stats: ShipStats, env: StepEnv, dts: number): void {
  const limit = cruiseSpeedLimit(env, s.pos, stats);
  // CRUISE_MIN_SPEED everywhere except close above a landable body, where the limit itself is lower.
  const floor = limit < CRUISE_MIN_SPEED ? limit : CRUISE_MIN_SPEED;
  const throttle = clamp(s.throttle, 0, 1);
  const target = s.fuel > 0 ? Math.max(floor, throttle * limit) : floor;
  const tau = target > s.cruiseSpeed ? CRUISE_TAU_UP : CRUISE_TAU_DOWN;
  const speed = s.cruiseSpeed + (target - s.cruiseSpeed) * (1 - Math.exp(-dts / tau));
  // The proximity limit is hard: it applies at once, however slowly the drive would spool down.
  s.cruiseSpeed = clamp(speed, floor, limit);

  const fwd = forwardOf(s.rot);
  s.vel[0] = fwd[0] * s.cruiseSpeed;
  s.vel[1] = fwd[1] * s.cruiseSpeed;
  s.vel[2] = fwd[2] * s.cruiseSpeed;
  s.pos[0] += s.vel[0] * dts;
  s.pos[1] += s.vel[1] * dts;
  s.pos[2] += s.vel[2] * dts;

  s.fuel = Math.max(0, s.fuel - CRUISE_FUEL_RATE * throttle * dts);
  if (stats.scoopRate > 0 && s.fuel < stats.fuelCap) {
    for (const src of env.sources) {
      if ((src as Partial<StepSource>).scoopable !== true) continue;
      if (v3.dist(s.pos, src.pos) <= SCOOP_MAX_RADII * src.radius) {
        s.fuel = Math.min(stats.fuelCap, s.fuel + stats.scoopRate * dts);
        break;
      }
    }
  }
}

// Scratch for the ground normal; `groundContact` allocates nothing.
const groundNormal: Vec3 = [0, 0, 0];

/**
 * Ground contact for a ship in normal flight in a surface frame, after its position was
 * integrated. The ship touches when its belly is at or below the terrain beneath it. A gentle touch
 * on ground that is level enough, with the ship upright, becomes `Landed`: the ship is set on
 * the ground, upright on the ground normal with its heading kept, at rest. Anything else is a
 * collision: the ship is lifted out of the ground, keeps GROUND_RESTITUTION of its speed into the
 * ground as a bounce and loses GROUND_FRICTION of its speed along it. `env.impact` receives the
 * speed in excess of what a landing allows.
 */
function groundContact(s: ShipState, stats: ShipStats, env: StepEnv): void {
  const ground = env.ground!;
  const x = s.pos[0];
  const y = s.pos[1];
  const z = s.pos[2];
  const r2 = x * x + y * y + z * z;
  // Above the highest ground there can be, the terrain need not be asked.
  const reach = ground.top + stats.belly;
  if (r2 >= reach * reach) return;
  // The direction must come out the same on every machine, hence the plain square root.
  const r = Math.sqrt(r2);
  const ux = r > 0 ? x / r : 0;
  const uy = r > 0 ? y / r : 1;
  const uz = r > 0 ? z / r : 0;
  const floor = ground.radius + terrainHeight(ground.terrain, ux, uy, uz) + stats.belly;
  if (r >= floor) return;

  // Touching. The ship origin goes back up to where its belly meets the ground.
  s.pos[0] = ux * floor;
  s.pos[1] = uy * floor;
  s.pos[2] = uz * floor;
  const n = groundNormal;
  const slope = terrainNormal(ground.terrain, ux, uy, uz, Math.max(2 * stats.radius, GROUND_BASELINE_MIN), n);
  const vn = s.vel[0] * n[0] + s.vel[1] * n[1] + s.vel[2] * n[2];
  const sx = s.vel[0] - vn * n[0];
  const sy = s.vel[1] - vn * n[1];
  const sz = s.vel[2] - vn * n[2];
  const sink = vn < 0 ? -vn : 0;
  const side = Math.sqrt(sx * sx + sy * sy + sz * sz);
  const up = quat.rotate(s.rot, [0, 1, 0]);
  const upright = up[0] * n[0] + up[1] * n[1] + up[2] * n[2];

  if (sink <= LAND_MAX_SINK && side <= LAND_MAX_SIDE && slope <= LAND_MAX_SLOPE && upright >= LAND_MIN_UPRIGHT) {
    // Heading kept: the nose direction with its part along the normal removed.
    const fwd = forwardOf(s.rot);
    const fn = fwd[0] * n[0] + fwd[1] * n[1] + fwd[2] * n[2];
    const rot = quat.lookRotation([fwd[0] - fn * n[0], fwd[1] - fn * n[1], fwd[2] - fn * n[2]], n);
    s.rot[0] = rot[0];
    s.rot[1] = rot[1];
    s.rot[2] = rot[2];
    s.rot[3] = rot[3];
    s.mode = FlightMode.Landed;
    standStill(s);
    return;
  }

  // A collision: bounce off the ground and scrape along it.
  const keep = 1 - GROUND_FRICTION;
  const bounce = vn < 0 ? -GROUND_RESTITUTION * vn : vn;
  s.vel[0] = sx * keep + bounce * n[0];
  s.vel[1] = sy * keep + bounce * n[1];
  s.vel[2] = sz * keep + bounce * n[2];
  const hard = Math.max(0, sink - LAND_MAX_SINK);
  const scrape = Math.max(0, side - LAND_MAX_SIDE);
  env.impact = Math.sqrt(hard * hard + scrape * scrape);
}

/** A ship standing on the ground does not move, turn or carry pending aim. */
function standStill(s: ShipState): void {
  s.vel[0] = 0;
  s.vel[1] = 0;
  s.vel[2] = 0;
  s.angVel[0] = 0;
  s.angVel[1] = 0;
  s.angVel[2] = 0;
  s.aim[0] = 0;
  s.aim[1] = 0;
  s.cruiseSpeed = 0;
}

/**
 * Energy, shield, heat, boost timers and drive charge. `heatInflux` is in heat units per second.
 * While `silent`, the shields are switched off and bleed away, and the closed radiators shed a
 * fraction of the usual heat while the reactor's waste heat stays in the hull.
 */
function stepSystems(s: ShipState, stats: ShipStats, heatInflux: number, dts: number, silent: boolean): void {
  s.energy = Math.min(stats.energyMax, s.energy + stats.energyRegen * dts);
  if (silent) {
    s.shield = Math.max(0, s.shield - stats.shieldMax * SILENT_SHIELD_DRAIN * dts);
    // Held at its full length, so the shields come back only a full delay after silent running ends.
    s.shieldDelay = stats.shieldDelay;
    const stored = heatInflux + stats.energyRegen * SILENT_REACTOR_HEAT - stats.cooling * SILENT_COOLING;
    s.heat = Math.max(0, s.heat + stored * dts);
  } else {
    if (s.shieldDelay > 0) s.shieldDelay = Math.max(0, s.shieldDelay - dts);
    else s.shield = Math.min(stats.shieldMax, s.shield + stats.shieldRegen * shieldRegenMul(s.pips) * dts);
    s.heat = Math.max(0, s.heat + (heatInflux - stats.cooling) * dts);
  }
  s.boost = Math.max(0, s.boost - dts);
  s.boostCd = Math.max(0, s.boostCd - dts);
  if (s.chargeKind !== ChargeKind.None) {
    const time = s.chargeKind === ChargeKind.Cruise ? CRUISE_CHARGE_TIME : FOLD_CHARGE_TIME;
    s.charge = Math.min(1, s.charge + dts / time);
  }
}

/**
 * Advances `s` in place by `dt` seconds of universe time.
 * Handles `Normal` and `Cruise` flight and `Landed`; in `Fold`, `Docked` and `Dead` only timers and
 * regeneration run.
 *
 * In a surface frame (`env.ground` present) normal flight collides with the terrain and may end in
 * `Landed`; `env.impact` is written each tick. A landed ship stays exactly where it is until the
 * pilot thrusts up (above LIFTOFF_THRUST) or fires the boost; no other input moves it.
 */
export function stepShip(s: ShipState, input: Readonly<ShipInput>, stats: ShipStats, env: StepEnv, dt: number): void {
  if (!(dt > 0) || dt === Infinity) return;
  s.pips = normalizePips(input.pips);
  if (env.ground) env.impact = 0;
  const cruising = s.mode === FlightMode.Cruise;
  const landed = s.mode === FlightMode.Landed;
  if (!cruising && !landed && s.mode !== FlightMode.Normal) {
    // Not flying: a held silent-running button has no effect, and there is nothing to detect.
    s.dilation = 1;
    stepSystems(s, stats, 0, dt, false);
    s.sig = shipSignature(s, stats, 0, false);
    return;
  }

  const silent = (input.buttons & Button.Silent) !== 0;
  if (landed) {
    const boost = (input.buttons & Button.Boost) !== 0 && s.boostCd <= 0 && s.energy >= BOOST_ENERGY;
    if (unit(input.thrust[1]) > LIFTOFF_THRUST || boost) {
      // Lift-off: a hop along the ship's up axis, which is the ground normal, then normal flight
      // from this very tick on.
      const up = quat.rotate(s.rot, [0, LIFTOFF_SPEED, 0]);
      s.vel[0] = up[0];
      s.vel[1] = up[1];
      s.vel[2] = up[2];
      s.mode = FlightMode.Normal;
    } else {
      // Standing on the ground: nothing moves, the systems run as in flight.
      s.dilation = dilationAt(env, s.pos, ORIGIN);
      s.fa = (input.buttons & Button.FaOff) === 0;
      s.throttle = unit(input.throttle);
      standStill(s);
      stepSystems(s, stats, heatInfluxAt(env, s.pos), dt * s.dilation, silent);
      s.sig = shipSignature(s, stats, 0, silent);
      return;
    }
  }

  // Cruise speed is not a physical velocity, so only gravity slows the ship's clock there.
  s.dilation = dilationAt(env, s.pos, cruising ? ORIGIN : s.vel);
  const dts = dt * s.dilation;
  s.fa = (input.buttons & Button.FaOff) === 0;
  s.throttle = unit(input.throttle);

  let thrust = 0;
  if (cruising) {
    stepRotation(s, input, stats, dts, CRUISE_TURN_FACTOR);
    stepCruise(s, stats, env, dts);
  } else {
    stepRotation(s, input, stats, dts, 1);
    thrust = stepNormal(s, input, stats, env, dts);
    if (env.ground) groundContact(s, stats, env);
  }
  stepSystems(s, stats, heatInfluxAt(env, s.pos), dts, silent);
  s.sig = shipSignature(s, stats, thrust, silent);
}

/**
 * One full tick for a ship inside a system: builds the environment, steps the ship and moves it
 * into another frame where it has crossed into one. Returns the environment used (after any
 * re-anchoring) so callers can evaluate hazards without rebuilding it; its `impact` is that of
 * this tick.
 *
 * - In cruise the anchor follows the sphere of influence the ship is in, and cruise ends where
 *   the ship comes below the ceiling of a landable body: it is then in normal flight in the
 *   surface frame, CRUISE_EXIT_SPEED along its nose over the ground, and `cruiseDrop` is set on
 *   the returned environment.
 * - In normal flight a ship that comes below `surfaceFrameAltitude` of a landable body moves into
 *   its surface frame, from whatever anchor it had, and back into the non-rotating frame of the
 *   body above SURFACE_FRAME_EXIT times that height. The trajectory is not changed by either.
 *
 * The state belongs to universe time `t` before the call and to `t + dt` after it, so the
 * re-anchoring is evaluated at `t + dt`.
 */
export function simulateShip(
  s: ShipState,
  input: Readonly<ShipInput>,
  stats: ShipStats,
  sys: SystemDef,
  t: number,
  dt: number,
): StepEnv {
  if (s.mode !== FlightMode.Normal && s.mode !== FlightMode.Cruise && s.mode !== FlightMode.Landed) {
    // No motion in these modes (and no anchor at all in a fold tunnel), so no sources are needed.
    const idle: StepEnv = { t, anchor: s.anchor, sources: [] };
    stepShip(s, input, stats, idle, dt);
    return idle;
  }
  let env = buildStepEnv(sys, s.anchor, t);
  stepShip(s, input, stats, env, dt);
  const t1 = t + dt;
  if (s.mode === FlightMode.Cruise) {
    const origin = anchorState(sys, s.anchor, t1).pos;
    const next = pickCruiseAnchor(sys, v3.add(origin, s.pos), t1);
    if (next !== s.anchor) {
      // The anchor offset is formed first so the small ship offset is not lost in the large sum.
      const shift = v3.sub(origin, anchorState(sys, next, t1).pos);
      s.pos[0] += shift[0];
      s.pos[1] += shift[1];
      s.pos[2] += shift[2];
      s.anchor = next;
      // Cruise speed is defined relative to whichever anchor the ship has; it is not carried over
      // as an absolute velocity.
      const fwd = forwardOf(s.rot);
      s.vel[0] = fwd[0] * s.cruiseSpeed;
      s.vel[1] = fwd[1] * s.cruiseSpeed;
      s.vel[2] = fwd[2] * s.cruiseSpeed;
      env = buildStepEnv(sys, next, t1);
    }
    const body = bodyWithin(env, s.pos, 'ceiling');
    if (body >= 0) {
      // Below the ceiling of a landable body the drive cuts out, without harm.
      reanchor(s, sys, surfaceAnchor(body), t1);
      s.mode = FlightMode.Normal;
      s.cruiseSpeed = 0;
      const fwd = forwardOf(s.rot);
      s.vel[0] = fwd[0] * CRUISE_EXIT_SPEED;
      s.vel[1] = fwd[1] * CRUISE_EXIT_SPEED;
      s.vel[2] = fwd[2] * CRUISE_EXIT_SPEED;
      env = buildStepEnv(sys, s.anchor, t1);
      env.cruiseDrop = true;
    }
  } else if (s.mode === FlightMode.Normal) {
    let next = s.anchor;
    if (env.ground) {
      if (v3.lenSq(s.pos) > env.ground.exit * env.ground.exit) next = env.ground.body;
    } else {
      const body = bodyWithin(env, s.pos, 'enter');
      if (body >= 0) next = surfaceAnchor(body);
    }
    if (next !== s.anchor) {
      const impact = env.impact;
      reanchor(s, sys, next, t1);
      env = buildStepEnv(sys, next, t1);
      if (impact !== undefined) env.impact = impact;
    }
  }
  return env;
}

/**
 * The landable body that `pos` (anchor frame) is close to: below the distance where its surface
 * frame begins (`enter`) or below its cruise ceiling (`ceiling`). -1 when there is none.
 */
function bodyWithin(env: StepEnv, pos: Readonly<Vec3>, limit: 'enter' | 'ceiling'): number {
  for (const src of env.sources) {
    if (!src.surface) continue;
    const d = src.surface[limit];
    if (v3.distSq(pos, src.pos) < d * d) return src.bodyId;
  }
  return -1;
}
