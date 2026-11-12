/**
 * The ground of a system's landable bodies as the simulation needs it: the terrain with the pads
 * of the ground bases, where the surface frame begins and ends, where cruise ends, and where the
 * ground bases stand. Everything here is derived from the `SystemDef` alone, so the server and
 * the client arrive at the same values.
 */
import { BASE_PAD_BLEND, BASE_PAD_RADIUS, CRUISE_CEILING_MARGIN, SURFACE_FRAME_EXIT } from '../constants.ts';
import { v3, type Quat, type Vec3 } from '../math.ts';
import { anchorFrame, groundSiteRotation, surfaceFrameAltitude } from './orbits.ts';
import { isLandable, terrainHeight, terrainMax, terrainParams, type TerrainPad, type TerrainParams } from './terrain.ts';
import type { SiteDef, SystemDef } from './types.ts';

/** The ground of one landable body. All distances are from the body centre, in metres. */
export interface BodySurface {
  /** Body id. */
  body: number;
  /** Mean radius. */
  radius: number;
  /** Terrain constants, including the pads of the ground sites. */
  terrain: TerrainParams;
  /** Normal flight uses the surface frame below this distance ... */
  enter: number;
  /** ... and the non-rotating body frame again above this one. */
  exit: number;
  /** No ground reaches higher than this. */
  top: number;
  /** Cruise ends below this: `top` plus CRUISE_CEILING_MARGIN. */
  ceiling: number;
  /** The ground sites standing on the body. */
  sites: SiteDef[];
}

/** Per system: the surfaces by body id (null for bodies that cannot be landed on) and the site count they were built for. */
const cache = new WeakMap<SystemDef, { sites: number; list: (BodySurface | null)[] }>();

/** Unit direction of a ground site's pad in body-fixed axes. Square root only, so it is the same on every machine. */
function padDirection(site: SiteDef): Vec3 {
  const p = site.ground!.pos;
  const l = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
  return l > 0 ? [p[0] / l, p[1] / l, p[2] / l] : [0, 1, 0];
}

function build(sys: SystemDef): (BodySurface | null)[] {
  return sys.bodies.map((body) => {
    if (!isLandable(body)) return null;
    const sites = sys.sites.filter((s) => s.ground !== undefined && s.ground.body === body.id);
    const pads: TerrainPad[] = sites.map((s) => ({ dir: padDirection(s), radius: BASE_PAD_RADIUS, blend: BASE_PAD_BLEND }));
    const terrain = terrainParams(body, pads);
    const altitude = surfaceFrameAltitude(body);
    const top = body.radius + terrainMax(terrain);
    return {
      body: body.id,
      radius: body.radius,
      terrain,
      enter: body.radius + altitude,
      exit: body.radius + SURFACE_FRAME_EXIT * altitude,
      top,
      ceiling: top + CRUISE_CEILING_MARGIN,
      sites,
    };
  });
}

/**
 * The surfaces of a system, index-aligned with `sys.bodies`; null for bodies that cannot be landed
 * on. Cached per `SystemDef` object and rebuilt when its number of sites changes. The ground
 * sites of a system are fixed when it is generated; do not move one afterwards.
 */
export function systemSurfaces(sys: SystemDef): readonly (BodySurface | null)[] {
  let entry = cache.get(sys);
  if (!entry || entry.sites !== sys.sites.length) {
    entry = { sites: sys.sites.length, list: build(sys) };
    cache.set(sys, entry);
  }
  return entry.list;
}

/** The ground of a body, or null when it cannot be landed on (or does not exist). */
export const bodySurface = (sys: SystemDef, bodyId: number): BodySurface | null => systemSurfaces(sys)[bodyId] ?? null;

/** Terrain constants of a body of a system, including the pads of its ground sites; null when it cannot be landed on. */
export const bodyTerrain = (sys: SystemDef, bodyId: number): TerrainParams | null => bodySurface(sys, bodyId)?.terrain ?? null;

/**
 * Centre distance (m) below which cruise ends at a landable body: its radius plus the highest
 * possible terrain plus CRUISE_CEILING_MARGIN. Null for bodies that cannot be landed on.
 */
export const cruiseCeiling = (sys: SystemDef, bodyId: number): number | null => bodySurface(sys, bodyId)?.ceiling ?? null;

/**
 * Height (m) of the point `pos` (surface frame of the body) above the ground beneath it.
 * Negative below ground.
 */
export function groundAltitude(surface: BodySurface, pos: Readonly<Vec3>): number {
  const r = Math.sqrt(pos[0] * pos[0] + pos[1] * pos[1] + pos[2] * pos[2]);
  if (!(r > 0)) return -surface.radius;
  return r - surface.radius - terrainHeight(surface.terrain, pos[0] / r, pos[1] / r, pos[2] / r);
}

/** Where a ground site stands and how it is turned. */
export interface GroundSitePose {
  /** In the surface frame of its body: pad centre and the rotation from the site's own axes (+Y up, -Z north). Constant. */
  surface: { pos: Vec3; rot: Quat };
  /** In system axes at the time asked for: barycentric position and velocity of the pad centre, and the same rotation. */
  system: { pos: Vec3; vel: Vec3; rot: Quat };
}

/** Position and orientation of a ground site, in the surface frame of its body and in system axes at time `t`. */
export function groundSitePose(sys: SystemDef, site: SiteDef, t: number): GroundSitePose {
  if (!site.ground) throw new Error(`site ${site.id} is not a ground site`);
  const f = anchorFrame(sys, site.id, t);
  return {
    surface: { pos: v3.clone(site.ground.pos), rot: groundSiteRotation(site) },
    system: { pos: f.pos, vel: f.vel, rot: f.rot },
  };
}

/**
 * The ground site of a body nearest to `pos` (surface frame of that body) and its distance from
 * the pad centre in metres; null when the body has none. This is how a ship in a surface frame
 * finds the base it is at, since a ground site is never its anchor.
 */
export function nearestGroundSite(sys: SystemDef, bodyId: number, pos: Readonly<Vec3>): { site: SiteDef; dist: number } | null {
  const surface = bodySurface(sys, bodyId);
  if (!surface) return null;
  let best: SiteDef | null = null;
  let bestSq = Infinity;
  for (const site of surface.sites) {
    const d = v3.distSq(pos, site.ground!.pos);
    if (d < bestSq) {
      bestSq = d;
      best = site;
    }
  }
  return best ? { site: best, dist: Math.sqrt(bestSq) } : null;
}
