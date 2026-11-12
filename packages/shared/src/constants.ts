/** Wire protocol version. Bump on any incompatible change to messages, snapshots or tickets. */
export const PROTOCOL_VERSION = 2;
export const GAME_VERSION = '0.1.0';

// --- simulation timing -------------------------------------------------------
export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;
/** A snapshot is sent every N simulation ticks. */
export const SNAPSHOT_EVERY = 2;
/** Universe time zero (UTC). Orbital positions are pure functions of seconds since this instant. */
export const UNIVERSE_EPOCH_MS = Date.UTC(2026, 0, 1);

// --- physical constants (SI) -------------------------------------------------
export const G = 6.6743e-11;
export const C = 299_792_458;
export const AU = 1.495978707e11;
export const LY = 9.4607304725808e15;
export const SOLAR_MASS = 1.98847e30;
export const SOLAR_RADIUS = 6.957e8;
export const SOLAR_LUMINOSITY = 3.828e26;
export const SOLAR_TEMP = 5772;
export const EARTH_MASS = 5.9722e24;
export const EARTH_RADIUS = 6.371e6;
export const JUPITER_MASS = 1.89813e27;
export const JUPITER_RADIUS = 6.9911e7;
export const DAY = 86_400;
export const YEAR = 31_557_600;

// --- anchors -----------------------------------------------------------------
/** Anchor ids below this are body indices; ids at or above are sites. */
export const SITE_ID_BASE = 1000;

// --- flight model ------------------------------------------------------------
/** Hard clamp for the pending mouse-aim buffer, radians per axis. */
export const AIM_BUFFER_MAX = 0.6;
/** Gain turning pending aim (rad) into a desired turn rate (rad/s). */
export const AIM_GAIN = 14;
/** Flight-assist velocity error time constant, seconds. */
export const FA_TAU = 0.35;
/** Seconds a boost lasts, seconds until the next one, and the energy it costs. */
export const BOOST_DURATION = 3.5;
export const BOOST_COOLDOWN = 6;
export const BOOST_ENERGY = 30;

// --- cruise (in-system FTL) --------------------------------------------------
export const CRUISE_MIN_SPEED = 30_000;
/** Default top cruise speed when a hull does not override it: 2000 c. */
export const CRUISE_MAX_SPEED = 2000 * C;
/** Speed limit near a body is distance-to-surface times this (1/s). */
export const CRUISE_PROXIMITY_K = 0.28;
export const CRUISE_CHARGE_TIME = 4;
/** Above this speed a manual cruise exit is an emergency drop (hull damage). */
export const CRUISE_SAFE_DROP_SPEED = 1_000_000;
/** Cruise cannot be engaged closer than this to a station or gate (mass lock). */
export const MASS_LOCK_RADIUS = 4_000;
/** Bodies are solid: cruising below radius * this factor forces an emergency drop. */
export const BODY_EXCLUSION_FACTOR = 1.04;
/** Compact objects kill inside rs * this factor (innermost stable orbit). */
export const COMPACT_KILL_FACTOR = 3;

/** Tonnes of fuel per second at full cruise throttle. */
export const CRUISE_FUEL_RATE = 0.0012;
/** Turn rates in cruise are scaled by this factor. */
export const CRUISE_TURN_FACTOR = 0.6;

// --- heat and fuel scooping --------------------------------------------------
/** Radiant heating in heat units per second = HEAT_FLUX_K * sqrt(flux in W/m^2). */
export const HEAT_FLUX_K = 3.5e-3;
/** A fuel scoop works within this many stellar radii of a scoopable star (centre distance). */
export const SCOOP_MAX_RADII = 2.6;
/** Hull damage per second per heat unit above the heat capacity. */
export const OVERHEAT_DAMAGE = 0.6;
/** Tidal stretch (m/s^2 across the hull) above which the hull takes damage. */
export const TIDAL_DAMAGE_THRESHOLD = 12;

// --- fold (inter-system jump) ------------------------------------------------
export const FOLD_CHARGE_TIME = 8;
export const FOLD_TUNNEL_TIME = 7;
/** Fuel (tonnes) per jump = FOLD_FUEL_BASE + FOLD_FUEL_PER_LY * distance * (distance / range). */
export const FOLD_FUEL_BASE = 0.4;
export const FOLD_FUEL_PER_LY = 0.18;
/** Arrival distance from the primary, in primary radii (stars) or metres floor. */
export const FOLD_ARRIVAL_RADII = 14;
export const FOLD_ARRIVAL_MIN = 4.0e9;
/** Fold arrivals are placed far enough out that radiant heating stays below this (heat units per second). */
export const FOLD_ARRIVAL_MAX_HEAT = 5;

// --- zones / interest --------------------------------------------------------
export const DEFAULT_SITE_FRAME_RADIUS = 250_000;
export const ZONE_VIEW_RADIUS = 120_000;
export const DOCK_RANGE = 1_500;
export const DOCK_MAX_SPEED = 120;
export const SCOOP_RANGE = 220;

// --- federation --------------------------------------------------------------
export const TICKET_TTL_MS = 120_000;
export const DESCRIPTOR_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
export const GOSSIP_INTERVAL_MS = 20_000;
export const PEER_TIMEOUT_MS = 90_000;
/** Maximum tolerated clock skew when checking signed, timestamped messages. */
export const MAX_CLOCK_SKEW_MS = 60_000;
/** Standalone sectors are placed inside this radius (ly) around the galactic reference point. */
export const CORE_REGION_RADIUS = 220;
export const DEFAULT_SECTOR_RADIUS = 18;

// --- limits (untrusted input) ------------------------------------------------
export const MAX_NAME_LENGTH = 24;
export const MAX_CHAT_LENGTH = 240;
export const MAX_SYSTEMS_PER_SECTOR = 64;
export const MAX_DESCRIPTOR_BYTES = 256 * 1024;
export const MAX_MESSAGE_BYTES = 64 * 1024;
