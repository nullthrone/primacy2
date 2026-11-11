import type { Quat, Vec3 } from '../math.ts';

export const FlightMode = { Normal: 0, Cruise: 1, Fold: 2, Docked: 3, Dead: 4 } as const;
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
  /** Metres, relative to the anchor, in non-rotating system axes. */
  pos: Vec3;
  /** Metres per second relative to the anchor. In cruise this is `forward * cruiseSpeed`. */
  vel: Vec3;
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
}

/** Everything about the surroundings that `stepShip` needs. Rebuilt every tick from the system and time. */
export interface StepEnv {
  /** Universe time of the tick. */
  t: number;
  anchor: number;
  sources: GravSource[];
}

/** Environmental dangers at a ship's position, evaluated by the server after each step. */
export interface Hazards {
  /** Body the ship is inside of (below the exclusion radius), or -1. */
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
