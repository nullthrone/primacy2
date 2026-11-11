/**
 * Procedural sectors and star systems. Deterministic: the same parameters always produce the
 * same systems on every machine, and system `i` does not depend on how many systems are generated.
 */
import type { Vec3 } from '../math.ts';
import type { GateInfo, SectorParams, SiteDef, SystemDef, SystemSummary } from './types.ts';

const TODO = (name: string): never => {
  throw new Error(`${name} is not implemented`);
};

/**
 * Positions of the systems of a sector relative to its centre (light years), index-aligned with
 * system indices. Independent of where the sector is placed, so a server can generate offsets
 * first and choose its centre afterwards. Systems keep a minimum separation of about 2 ly.
 */
export function sectorOffsets(serverId: string, seed: string, radius: number, count: number): Vec3[] {
  return TODO('sectorOffsets');
}

export interface PlacementPeer {
  pos: Vec3;
  radius: number;
  systems: { pos: Vec3 }[];
}

export interface PlacementArgs {
  serverId: string;
  /** Own system offsets from `sectorOffsets`. */
  offsets: Vec3[];
  radius: number;
  /** The first reachable bootstrap peer, or null for a standalone server. */
  peer: PlacementPeer | null;
  /** Every other known sector; the new sector avoids overlapping their centres. */
  others: { pos: Vec3; radius: number }[];
  /** Jump range (ly) the closest pair of systems must be within. */
  reach: number;
}

/**
 * Chooses a sector centre. With a peer, the sector is placed adjacent to it in a direction derived
 * from the server id, at the distance where the closest pair of systems (one of ours, one of the
 * peer's) is between 0.5 * reach and 0.9 * reach apart, trying further directions when the spot
 * overlaps another known sector. Without a peer, a position derived from the server id inside
 * the core region (CORE_REGION_RADIUS, flattened to a disc).
 */
export function chooseSectorCenter(args: PlacementArgs): Vec3 {
  return TODO('chooseSectorCenter');
}

/** Generates all systems of a sector. `result[i].id` is `${serverId}:${i}`. */
export function generateSector(p: SectorParams): SystemDef[] {
  return TODO('generateSector');
}

/** Generates one system. `pos` is its galactic position. */
export function generateSystem(serverId: string, seed: string, index: number, pos: Vec3): SystemDef {
  return TODO('generateSystem');
}

export function summarize(def: SystemDef): SystemSummary {
  return TODO('summarize');
}

/**
 * Adds a warp gate site to a system (mutating `sys.sites`) and returns it. The gate orbits the
 * primary beyond the outermost planet, on the side facing `towards` (galactic direction to the
 * far end), so its placement is deterministic for both ends. Reuses the existing site when one
 * with the same `gate.linkId` is already present (updating its gate info).
 */
export function upsertGateSite(sys: SystemDef, gate: GateInfo, towards: Readonly<Vec3>): SiteDef {
  return TODO('upsertGateSite');
}

/** The closest pair between two sets of systems and their distance in light years. */
export function nearestPair<A extends { pos: Vec3 }, B extends { pos: Vec3 }>(
  a: readonly A[],
  b: readonly B[],
): { a: A; b: B; dist: number } | null {
  return TODO('nearestPair');
}
