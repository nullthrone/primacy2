import type { Vec3 } from '../math.ts';

/** Spectral classes plus compact objects: white dwarf, neutron star, black hole. */
export type StarClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M' | 'WD' | 'NS' | 'BH';
export type PlanetClass = 'rocky' | 'desert' | 'lava' | 'ice' | 'ocean' | 'terran' | 'gas' | 'icegiant';
export type BodyKind = 'star' | 'planet' | 'moon';

/**
 * Kepler orbit around a parent body. Angles in radians, lengths in metres, times in seconds.
 * The reference plane is the system XZ plane (+Y is the system's north).
 */
export interface OrbitDef {
  /** Body id of the parent. */
  parent: number;
  /** Semi-major axis. */
  a: number;
  /** Eccentricity, 0 <= e < 1. */
  e: number;
  /** Inclination against the XZ plane. */
  inc: number;
  /** Longitude of the ascending node. */
  node: number;
  /** Argument of periapsis. */
  argp: number;
  /** Mean anomaly at universe time 0. */
  m0: number;
  /** Orbital period. */
  period: number;
}

export interface BodyDef {
  /** Index into `SystemDef.bodies`; also the body's anchor id. Body 0 is the primary and has no orbit. */
  id: number;
  name: string;
  kind: BodyKind;
  cls: StarClass | PlanetClass;
  mass: number;
  radius: number;
  orbit: OrbitDef | null;
  /** Sidereal rotation period in seconds (negative = retrograde). */
  rotPeriod: number;
  /** Axial tilt in radians. */
  tilt: number;
  /** Visual seed for procedural surface shaders. */
  seed: number;
  /** Base colour 0xRRGGBB (star light colour, or dominant surface colour). */
  color: number;
  /** Effective temperature in kelvin (stars) or mean surface temperature (planets). */
  temp: number;
  /** Luminosity in watts. Stars only. */
  lum?: number;
  /** Schwarzschild radius in metres. Set for NS and BH only. */
  rs?: number;
  atmo?: { height: number; color: number; density: number };
  rings?: { inner: number; outer: number; color: number; seed: number };
  /** Accretion disk (black holes, some neutron stars). Radii in metres. */
  disk?: { inner: number; outer: number; color: number };
  /** Relativistic jets along the rotation axis (pulsars). Length in metres. */
  jets?: { length: number; color: number };
  /** True when a fuel scoop works in this star's corona. */
  scoopable?: boolean;
  /** True for planets inside the habitable zone with liquid water. */
  habitable?: boolean;
}

export type BeltKind = 'rock' | 'metal' | 'ice';

/** A circumstellar or circumplanetary asteroid belt, rendered as a whole from afar. */
export interface BeltDef {
  id: number;
  name: string;
  /** Body the belt orbits. */
  parent: number;
  inner: number;
  outer: number;
  /** Full vertical thickness. */
  height: number;
  kind: BeltKind;
  /** 0..1, scales ore yield. */
  richness: number;
  seed: number;
}

/** `base` is a ground base on a landable body; every other kind orbits. */
export type SiteKind = 'station' | 'outpost' | 'belt' | 'ring' | 'beacon' | 'gate' | 'anomaly' | 'base';
export type StationService = 'market' | 'outfit' | 'shipyard' | 'missions' | 'repair' | 'refuel' | 'cartography';
export type EconomyType = 'agri' | 'mining' | 'refinery' | 'industrial' | 'hightech' | 'military' | 'outpost';
export type GateState = 'planned' | 'building' | 'active' | 'dormant';

export interface GateInfo {
  /** Shared id of the gate pair (both ends carry the same id). */
  linkId: string;
  /** Server id of the far end. */
  peer: string;
  /** System id of the far end. */
  remoteSystem: string;
  state: GateState;
  /** Local construction progress, 0..1. */
  progress: number;
  /** Far end's construction progress as last reported, 0..1. */
  remoteProgress: number;
}

/**
 * A site is a point of interest with its own anchor frame: ships arriving there share a zone.
 * Site anchor ids are `SITE_ID_BASE + n`.
 *
 * A ground site (`ground` set) stands on a landable body instead. It has no zone of its own:
 * ships near it fly in the surface frame of the body, and only a docked ship has the site as
 * its anchor. Use `anchorState` for where it is; its `orbit` says nothing but the body.
 */
export interface SiteDef {
  id: number;
  kind: SiteKind;
  name: string;
  /**
   * Orbit around `orbit.parent` (a body id). For a ground site the parent is the body it stands
   * on and the orbit is empty (`a` = 0), so code that only reads the parent keeps working.
   */
  orbit: OrbitDef;
  /** Radius of the site's zone in metres; 0 for a ground site. */
  frameRadius: number;
  seed: number;
  /**
   * Model key, e.g. `station_ring`: a key of `STRUCTURES`. Present for stations, outposts, gates
   * and beacons. Ground bases have none until their model is built (`GROUND_BASE_STRUCTURE`).
   */
  model?: string;
  /** Collision radius of the structure in metres. */
  radius?: number;
  services?: StationService[];
  economy?: EconomyType;
  faction?: string;
  /** For `belt` sites: the belt this site lies in. For `ring` sites the parent body's rings are used. */
  beltId?: number;
  gate?: GateInfo;
  /** Ground sites only: the body and the centre of the pad in its body-fixed axes, metres from the body centre. */
  ground?: { body: number; pos: Vec3 };
}

export type Security = 'secure' | 'frontier' | 'lawless';

/** What other servers and the galaxy map need to know about a system. */
export interface SystemSummary {
  /** Globally unique: `${serverId}:${index}`. */
  id: string;
  name: string;
  /** Galactic position in light years. */
  pos: Vec3;
  starClass: StarClass;
  security: Security;
  /**
   * Number of places to dock. In a summary made by `summarize` these are the stations, outposts
   * and ground bases; in a `SystemDef` as generated the stations and outposts alone.
   */
  stations: number;
  /**
   * Notable features for the map, e.g. `['blackhole', 'belt', 'gate']`. `summarize` adds `base`
   * for a system with a ground base.
   */
  tags: string[];
}

export interface SystemDef extends SystemSummary {
  seed: number;
  bodies: BodyDef[];
  belts: BeltDef[];
  sites: SiteDef[];
  /** Controlling faction name, if any. */
  faction?: string;
}

export type OreId =
  | 'iron_ore' | 'copper_ore' | 'titanium_ore' | 'platinum_ore' | 'silicates' | 'ice' | 'helium3'
  /** Only found at `anomaly` sites near black holes and neutron stars. */
  | 'exotic_matter';

/** One asteroid of a mining site, positioned relative to the site anchor. */
export interface AsteroidDef {
  /** Index within the site; stable across server and client. */
  idx: number;
  pos: Vec3;
  radius: number;
  /** Mesh variant 0..3. */
  variant: number;
  /** Unit rotation axis and spin rate in rad/s. */
  axis: Vec3;
  spin: number;
  /** Initial rotation phase in radians. */
  phase: number;
  ore: OreId;
  /** Units of ore the asteroid holds when fresh. */
  amount: number;
}

export interface SectorParams {
  serverId: string;
  /** Operator-chosen seed; combined with the server id. */
  seed: string;
  /** Sector centre in galactic light years. */
  center: Vec3;
  /** Sector radius in light years. */
  radius: number;
  /** Number of systems to generate, 1..MAX_SYSTEMS_PER_SECTOR. */
  count: number;
}

export interface StateVector {
  pos: Vec3;
  vel: Vec3;
}
