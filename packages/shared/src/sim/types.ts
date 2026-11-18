import type { Quat, Vec3 } from '../math.ts';
import type { TerrainParams } from '../universe/terrain.ts';

/** `Landed`: standing on the ground of a landable body, in its surface frame. */
export const FlightMode = { Normal: 0, Cruise: 1, Fold: 2, Docked: 3, Dead: 4, Landed: 5 } as const;
export type FlightMode = (typeof FlightMode)[keyof typeof FlightMode];

export const ChargeKind = { None: 0, Cruise: 1, Fold: 2 } as const;
export type ChargeKind = (typeof ChargeKind)[keyof typeof ChargeKind];

/** Bit flags in `ShipInput.buttons`. These are levels (held state), not edges. */
export const Button = {
  Fire1: 1,
  Fire2: 2,
  Boost: 4,
  /** Hold to brake to a stop regardless of other thrust input. */
  Brake: 8,
  /** Flight assist disabled while set. */
  FaOff: 16,
  /** Mining/tool group. */
  Fire3: 32,
  /** Silent running while set: shields offline, radiators closed, much smaller heat signature. */
  Silent: 64,
} as const;

/** One tick of pilot input. See docs/ARCHITECTURE.md for sign conventions. */
export interface ShipInput {
  /** Monotonic per-connection sequence number. */
  seq: number;
  /** `[right, up, forward]`, each -1..1. */
  thrust: Vec3;
  /** `[yawRight, pitchUp]` radians of mouse-look accumulated during this tick. */
  aim: [number, number];
  /** -1..1, positive rolls right. */
  roll: number;
  /** Persistent forward throttle setpoint, -1..1 (0..1 in cruise). */
  throttle: number;
  buttons: number;
  /** Power distribution, packed by `packPips`. Absent or invalid means the default 4/4/4. */
  pips?: number;
}

export const NEUTRAL_INPUT: Readonly<ShipInput> = Object.freeze({
  seq: 0,
  thrust: [0, 0, 0] as Vec3,
  aim: [0, 0] as [number, number],
  roll: 0,
  throttle: 0,
  buttons: 0,
});

/**
 * Dynamic state of a ship. Everything `stepShip` needs to advance one tick lives here,
 * so the client can predict with the same function the server uses.
 */
export interface ShipState {
  mode: FlightMode;
  /** Anchor id the position is relative to; -1 while in `Fold`. */
  anchor: number;
  /**
   * Metres, relative to the anchor, in the axes of the anchor frame: non-rotating system axes for
   * body and orbital site anchors, the rotating body-fixed axes for a surface anchor.
   */
  pos: Vec3;
  /** Metres per second in the anchor frame (over the ground in a surface frame). In cruise this is `forward * cruiseSpeed`. */
  vel: Vec3;
  /** Orientation in the axes of the anchor frame. */
  rot: Quat;
  /** Ship-local angular velocity, rad/s. */
  angVel: Vec3;
  /** Pending mouse aim `[yawRight, pitchUp]` in radians, worked off at the hull's turn rate. */
  aim: [number, number];
  /** Flight assist enabled. */
  fa: boolean;
  /** Last applied throttle setpoint. */
  throttle: number;
  /** Scalar speed along the nose in cruise, m/s. */
  cruiseSpeed: number;
  /** Seconds of boost remaining. */
  boost: number;
  /** Seconds until boost is available again. */
  boostCd: number;
  energy: number;
  heat: number;
  /** Tonnes of fuel. */
  fuel: number;
  shield: number;
  hull: number;
  /** Seconds until shield regeneration resumes. */
  shieldDelay: number;
  /** 0..1 progress of the cruise or fold charge. */
  charge: number;
  chargeKind: ChargeKind;
  /** Time dilation factor applied last tick (1 = none, towards 0 = slower). */
  dilation: number;
  /** Power distribution applied last tick, packed by `packPips`. */
  pips: number;
  /**
   * Heat signature as of last tick; 1 is a reference-sized ship idling with shields up.
   * Decides from how far other ships detect this one (`canDetect`).
   */
  sig: number;
}

/** A resolved weapon on a hardpoint. */
export interface WeaponMount {
  /** Module id. */
  id: string;
  /** Fire group: 1 = primary, 2 = secondary, 3 = tool. */
  group: 1 | 2 | 3;
  kind: 'pulse' | 'beam' | 'cannon' | 'missile' | 'mining';
  /** Damage per shot, or per second for beams and mining lasers. */
  damage: number;
  /** Shots per second (ignored for beams). */
  rate: number;
  /** Energy per shot, or per second for beams. */
  energy: number;
  /** Heat per shot, or per second for beams. */
  heat: number;
  range: number;
  /** Projectile speed in m/s; 0 for hitscan. */
  speed: number;
  shieldMul: number;
  hullMul: number;
  /** Half-angle in radians within which shots snap to the locked target. */
  gimbal: number;
  /** Mount offset from the ship origin in ship-local metres. */
  offset: Vec3;
}

/** Capabilities derived from a hull and its fitted modules by `computeShipStats`. */
export interface ShipStats {
  hull: string;
  /** Kilograms, including modules (cargo excluded). */
  mass: number;
  /** Collision radius in metres. */
  radius: number;
  /** Metres from the ship origin down to its lowest point: how high the origin stands when landed. */
  belly: number;
  accelFwd: number;
  accelBack: number;
  accelLat: number;
  accelVert: number;
  /** Flight-assist speed limit, m/s. */
  maxSpeed: number;
  boostSpeed: number;
  /** Thrust multiplier while boosting. */
  boostAccel: number;
  /** Turn rate limits, rad/s. */
  turnPitch: number;
  turnYaw: number;
  turnRoll: number;
  /** Angular acceleration limit, rad/s^2. */
  angAccel: number;
  hullMax: number;
  shieldMax: number;
  /** Shield points per second once regeneration resumes. */
  shieldRegen: number;
  /** Seconds after a hit before shields regenerate. */
  shieldDelay: number;
  energyMax: number;
  energyRegen: number;
  heatCap: number;
  /** Heat units shed per second. */
  cooling: number;
  /** Tonnes. */
  cargoCap: number;
  fuelCap: number;
  /** Light years per fold jump. */
  jumpRange: number;
  /** Top cruise speed, m/s. */
  cruiseMax: number;
  /** Tonnes of fuel per second scooped at optimal distance; 0 without a scoop. */
  scoopRate: number;
  /** Sensor range for contacts in normal space, metres. */
  sensorRange: number;
  /** True when a detailed scanner is fitted (exploration data). */
  scanner: boolean;
  weapons: WeaponMount[];
}

/** A massive body as seen from a ship's anchor frame. */
export interface GravSource {
  bodyId: number;
  /** G * mass. */
  mu: number;
  /** Position of the body relative to the anchor, metres. */
  pos: Vec3;
  radius: number;
  /** Schwarzschild radius; 0 for ordinary bodies. */
  rs: number;
  /** True when this body is the anchor itself (full gravity, no tidal subtraction). */
  isAnchor: boolean;
  /** Luminosity in watts (stars), else 0. Drives radiant heating. */
  lum: number;
  /** True when a fuel scoop works in the corona of this body. Absent means no. */
  scoopable?: boolean;
  /**
   * Landable bodies only. `enter`: centre distance (m) below which normal flight uses the body's
   * surface frame. `ceiling`: centre distance below which cruise ends (the highest possible
   * ground plus CRUISE_CEILING_MARGIN). Such a body has no exclusion radius; its terrain is the limit.
   */
  surface?: { enter: number; ceiling: number };
}

/** The ground under a ship whose anchor is a surface frame. */
export interface StepGround {
  /** Body id. */
  body: number;
  /** Mean radius of the body, metres. */
  radius: number;
  /** Centre distance (m) above which no ground can be: radius plus the highest terrain. */
  top: number;
  /** Centre distance (m) above which normal flight goes back to the non-rotating body frame. */
  exit: number;
  /** Terrain constants; the type lives in `universe/terrain.ts`. */
  terrain: TerrainParams;
}

/** Everything about the surroundings that `stepShip` needs. Rebuilt every tick from the system and time. */
export interface StepEnv {
  /** Universe time of the tick. */
  t: number;
  anchor: number;
  /** Gravitating bodies, positions in the axes of the anchor frame. */
  sources: GravSource[];
  /** Angular velocity of the anchor frame in its own axes, rad/s. Absent for a non-rotating frame. */
  omega?: Vec3;
  /** Present when the anchor is a surface frame. */
  ground?: StepGround;
  /**
   * Written by `stepShip` when `ground` is present: how hard the ship hit the ground this tick,
   * as the speed in m/s in excess of what a landing allows (0 for no contact, a landing or a
   * touch within the limits). The server turns it into hull damage.
   */
  impact?: number;
  /** Set by `simulateShip` on the environment it returns when cruise ended this tick because the ship came below a ceiling. */
  cruiseDrop?: boolean;
}

/** Environmental dangers at a ship's position, evaluated by the server after each step. */
export interface Hazards {
  /** Body the ship is inside of (below the exclusion radius), or -1. Never a landable body: there the terrain is the limit. */
  insideBody: number;
  /** True inside the lethal radius of a compact object. */
  lethal: boolean;
  /** Tidal stretch across the hull in m/s^2. */
  tidal: number;
  /** Radiant heat influx in heat units per second (before cooling). */
  heatInflux: number;
  /** Magnitude of the local gravitational acceleration in the anchor frame, m/s^2. */
  gravity: number;
  /** Id of the body dominating gravity, or -1. */
  dominantBody: number;
}
