/**
 * The geometry a frame view needs near the ground: turning what the simulation keeps in the axes
 * of an anchor frame into system axes, the view data about the landable body below, and keeping
 * a camera above the terrain. Pure functions of the system, the time and the ship state, so the
 * game core and the development pages build their views from the same code. Heights and normals
 * come from the shared terrain; nothing here knows how the ground is shaped.
 */
import {
  FlightMode,
  GROUND_BASELINE_MIN,
  anchorBody,
  anchorFrame,
  bodyRotation,
  bodySurface,
  findSite,
  groundAltitude,
  groundSiteRotation,
  isRotatingAnchor,
  isSurfaceAnchor,
  quat,
  reanchor,
  surfaceAnchor,
  systemSurfaces,
  terrainHeight,
  terrainNormal,
  v3,
  type BodySurface,
  type Quat,
  type ShipState,
  type ShipStats,
  type StateVector,
  type SystemDef,
  type Vec3,
} from '@primacy2/shared';
import type { SurfaceShipView, SurfaceView } from '../contracts.ts';

/** The view carries `surface` while the camera is within this many body radii of the centre of a landable body. */
export const SURFACE_VIEW_RADII = 3;
/** A chase, docked or wreck camera is kept at least this far above the ground, metres. */
export const CAMERA_GROUND_CLEARANCE = 2;

/** The frame of an anchor as the view builder needs it. */
export interface ViewFrame {
  /** The anchor id. */
  anchor: number;
  /** Barycentric position of the frame's origin, metres. */
  pos: Vec3;
  /** Turns the frame's axes into system axes; null when they are system axes already. */
  rot: Quat | null;
}

/** The frame of an anchor at universe time `t`. Throws on unknown ids, as `anchorFrame` does. */
export function viewFrame(sys: SystemDef, anchor: number, t: number): ViewFrame {
  const f = anchorFrame(sys, anchor, t);
  return { anchor, pos: f.pos, rot: isRotatingAnchor(sys, anchor) ? f.rot : null };
}

/** A vector in the axes of the frame, in system axes. Always a new array. */
export const toSystem = (f: ViewFrame, v: Readonly<Vec3>): Vec3 => (f.rot ? quat.rotate(f.rot, v) : [v[0], v[1], v[2]]);
/** A vector in system axes, in the axes of the frame. Always a new array. */
export const toFrame = (f: ViewFrame, v: Readonly<Vec3>): Vec3 => (f.rot ? quat.unrotate(f.rot, v) : [v[0], v[1], v[2]]);
/** An orientation given in the axes of the frame, in system axes. */
export const rotToSystem = (f: ViewFrame, q: Readonly<Quat>): Quat => (f.rot ? quat.normalize(quat.mul(f.rot, q)) : [q[0], q[1], q[2], q[3]]);

/**
 * A point given in the frame of `f` as a position in the body-fixed axes of `surface`'s body.
 * Exact wherever the frame belongs to that body (its surface frame, its body frame, a ground site
 * on it); from any other frame the large difference of the two origins costs a fraction of a
 * millimetre.
 */
export function bodyFixed(sys: SystemDef, f: ViewFrame, local: Readonly<Vec3>, surface: BodySurface, bodyRot: Readonly<Quat>, bodyPos: Readonly<Vec3>): Vec3 {
  if (f.anchor === surfaceAnchor(surface.body)) return [local[0], local[1], local[2]];
  if (f.anchor === surface.body) return quat.unrotate(bodyRot, local);
  const site = findSite(sys, f.anchor);
  if (site?.ground && site.ground.body === surface.body) return v3.add(site.ground.pos, quat.rotate(groundSiteRotation(site), local));
  // The difference of the origins first, so the small offset is not lost in the large sum.
  return quat.unrotate(bodyRot, v3.add(v3.sub(f.pos, bodyPos), toSystem(f, local)));
}

/**
 * Keeps a camera above the terrain: `local` (a position in the frame of `f`) is returned raised
 * along the local vertical until it is `clearance` metres above the ground beneath it. Positions
 * that are high enough, and frames that are not at the ground of a landable body (anything but a
 * surface frame or a ground site), come back unchanged.
 */
export function liftAboveGround(sys: SystemDef, f: ViewFrame, local: Readonly<Vec3>, clearance = CAMERA_GROUND_CLEARANCE): Vec3 {
  const out: Vec3 = [local[0], local[1], local[2]];
  const site = isSurfaceAnchor(f.anchor) ? undefined : findSite(sys, f.anchor);
  const body = isSurfaceAnchor(f.anchor) ? anchorBody(f.anchor) : (site?.ground?.body ?? -1);
  const surface = body >= 0 ? bodySurface(sys, body) : null;
  if (!surface) return out;
  const siteRot = site?.ground ? groundSiteRotation(site) : null;
  const p = siteRot ? v3.add(site!.ground!.pos, quat.rotate(siteRot, out)) : out;
  const r2 = v3.lenSq(p);
  // Above the highest ground of the body nothing needs to be asked.
  if (r2 >= (surface.top + clearance) ** 2) return out;
  const low = clearance - groundAltitude(surface, p);
  if (!(low > 0)) return out;
  const up = v3.scale(p, low / Math.sqrt(r2));
  return v3.add(out, siteRot ? quat.unrotate(siteRot, up) : up);
}

/** Unit vector straight up at a point of the frame `f`, in the frame's axes: away from the body in a surface frame, +Y elsewhere. */
export function frameUp(f: ViewFrame, local: Readonly<Vec3>): Vec3 {
  if (!isSurfaceAnchor(f.anchor)) return [0, 1, 0];
  const up = v3.normalize(local);
  return v3.lenSq(up) > 0 ? up : [0, 1, 0];
}

/**
 * The landable body the camera is near: the one whose ground is nearest among those whose centre
 * is within SURFACE_VIEW_RADII radii of the camera, or null. `camOffset` is the camera position
 * relative to the origin of `f`, in system axes.
 */
function nearBody(sys: SystemDef, f: ViewFrame, camOffset: Readonly<Vec3>, bodyStates: readonly StateVector[]): BodySurface | null {
  let best: BodySurface | null = null;
  let bestHeight = Infinity;
  for (const surface of systemSurfaces(sys)) {
    if (!surface) continue;
    const dist = v3.len(v3.add(v3.sub(f.pos, bodyStates[surface.body]!.pos), camOffset));
    const height = dist - surface.radius;
    if (dist < SURFACE_VIEW_RADII * surface.radius && height < bestHeight) {
      best = surface;
      bestHeight = height;
    }
  }
  return best;
}

/** The pilot's ship over the ground of a body: `state` may be in any frame of the system. */
function shipOverGround(sys: SystemDef, surface: BodySurface, bodyRot: Readonly<Quat>, state: ShipState, stats: ShipStats, t: number): SurfaceShipView {
  let pos: Readonly<Vec3> = state.pos;
  let vel: Readonly<Vec3> = state.vel;
  const frame = surfaceAnchor(surface.body);
  if (state.anchor !== frame) {
    // Position and velocity over the ground, whatever frame the ship is flown in.
    const s: ShipState = { ...state, pos: [state.pos[0], state.pos[1], state.pos[2]], vel: [state.vel[0], state.vel[1], state.vel[2]], rot: [state.rot[0], state.rot[1], state.rot[2], state.rot[3]] };
    reanchor(s, sys, frame, t);
    pos = s.pos;
    vel = s.vel;
  }
  const r = v3.len(pos);
  const up: Vec3 = r > 0 ? [pos[0] / r, pos[1] / r, pos[2] / r] : [0, 1, 0];
  const ground = surface.radius + terrainHeight(surface.terrain, up[0], up[1], up[2]);
  const normal: Vec3 = [0, 0, 0];
  // The same footprint the landing check measures the ground over.
  const rise = terrainNormal(surface.terrain, up[0], up[1], up[2], Math.max(2 * stats.radius, GROUND_BASELINE_MIN), normal);
  const climb = v3.dot(vel, up);
  return {
    pos: [pos[0], pos[1], pos[2]],
    height: r - ground - stats.belly,
    verticalSpeed: climb,
    groundSpeed: v3.len(v3.addScaled(vel, up, -climb)),
    slope: Math.atan(rise),
    landed: state.mode === FlightMode.Landed,
    up: quat.rotate(bodyRot, up),
    normal: quat.rotate(bodyRot, normal),
  };
}

/**
 * The `surface` part of a frame view: the landable body near the camera, how it is turned, where
 * the camera is over it and how the pilot's ship stands to its ground. Null when no landable
 * body is within SURFACE_VIEW_RADII radii of the camera.
 *
 * `camLocal` is the camera position in the frame `f`; `ship` is the pilot's ship as the
 * simulation has it (null when the view shows none); `bodyStates` are the body positions at `t`.
 */
export function surfaceView(
  sys: SystemDef,
  t: number,
  f: ViewFrame,
  camLocal: Readonly<Vec3>,
  bodyStates: readonly StateVector[],
  ship: { state: ShipState; stats: ShipStats } | null,
): SurfaceView | null {
  const surface = nearBody(sys, f, toSystem(f, camLocal), bodyStates);
  if (!surface) return null;
  const body = sys.bodies[surface.body]!;
  const rot = bodyRotation(body, t);
  const cam = bodyFixed(sys, f, camLocal, surface, rot, bodyStates[surface.body]!.pos);
  return {
    body: surface.body,
    rot,
    cam,
    camHeight: groundAltitude(surface, cam),
    ship: ship ? shipOverGround(sys, surface, rot, ship.state, ship.stats, t) : null,
  };
}
