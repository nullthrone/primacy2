/**
 * Builds synthetic `FrameView`s for development pages and screenshot tests, so renderers and the
 * HUD can be worked on without a server. Not used by the game itself.
 *
 * The views are put together by the same functions the game core uses (`game/surface.ts`), so
 * what a renderer sees here about frames, the ground and the camera is what it sees in the game.
 */
import {
  FlightMode,
  GROUND_BASELINE_MIN,
  LAND_MAX_SLOPE_DEG,
  allBodyStates,
  bodyRotation,
  bodySurface,
  computeShipStats,
  findSite,
  generateAsteroids,
  generateSector,
  groundSiteRotation,
  idFromPublicKey,
  newShipState,
  publicKeyOf,
  quat,
  sha256Hex,
  starterLoadout,
  surfaceAnchor,
  terrainHeight,
  terrainNormal,
  v3,
  type BodyDef,
  type BodySurface,
  type GalaxyView,
  type Quat,
  type ShipInput,
  type ShipState,
  type SiteDef,
  type SystemDef,
  type Vec3,
} from '@primacy2/shared';
import type { EntityView, FrameFx, FrameView, GraphicsSettings } from '../contracts.ts';
import { chaseCamera, rotToSystem, sceneryView, surfaceView, toSystem, viewFrame, type ViewFrame } from '../game/surface.ts';

export const DEMO_SERVER_ID = 'demodemodemodemo';

/** A deterministic sector for development: index 0 is a capital, 3 a black hole, 5 a neutron star. */
export function demoSector(count = 8, seed = 'demo'): SystemDef[] {
  return generateSector({ serverId: DEMO_SERVER_ID, seed, center: [0, 0, 0], radius: 18, count });
}

/**
 * The first `count` systems of server Alpha in the fixed test universe `label`: the systems the
 * browser test and a developer with `PRIMACY2_FIXED_UNIVERSE=<label>` play in, generated here as
 * that server generates them. `scripts/dev.ts` derives the server's identity from the label, and
 * the content of a system depends on nothing but the server's id, its seed and the index.
 */
export function fixedSector(label: string, count = 4): SystemDef[] {
  const serverId = idFromPublicKey(publicKeyOf(sha256Hex(`primacy2-dev:alpha-${label}`)));
  return generateSector({ serverId, seed: 'alpha', center: [0, 0, 0], radius: 18, count });
}

export function demoGalaxy(systems: SystemDef[]): GalaxyView {
  const summaries = systems.map((s) => ({
    id: s.id, name: s.name, pos: s.pos, starClass: s.starClass, security: s.security, stations: s.stations, tags: s.tags,
  }));
  return {
    self: DEMO_SERVER_ID,
    sectors: [
      {
        id: DEMO_SERVER_ID, name: 'Demo Reach', url: 'http://localhost:8420', pos: [0, 0, 0], radius: 18,
        online: true, linked: true, trust: 'union', tier: 'union', rulesMatch: true, allowance: null, entryTier: 'union', entryHullCap: null,
        players: 3, systems: summaries, links: [], gates: [],
      },
    ],
  };
}

export interface FakeViewOptions {
  system: SystemDef;
  /** Universe time in seconds. */
  time?: number;
  /** Anchor (body, surface frame or site id) the camera is placed relative to. */
  anchor: number;
  /** Camera position relative to the anchor in the axes of its frame, metres. */
  offset: Vec3;
  /** Point to look at, relative to the anchor. Ignored when `rot` is given. Defaults to the anchor itself. */
  lookAt?: Vec3;
  /** Camera orientation in system axes. */
  rot?: Quat;
  fov?: number;
  mode?: FlightMode;
  /** Hull of the pilot's own ship; null for no ship. Default `wisp`. */
  hull?: string | null;
  /** Own ship position relative to the camera, system axes. Default: cockpit view (ship around the camera). */
  selfRel?: Vec3;
  /** Overrides for the ship state; `pos`, `vel` and `rot` are in the axes of the anchor frame. */
  selfState?: Partial<ShipState>;
  /** The pilot's input, for thruster effects. Default: flying ahead at part throttle. */
  input?: ShipInput;
  ents?: EntityView[];
  fx?: Partial<FrameFx>;
  graphics?: Partial<GraphicsSettings>;
  cameraMode?: 'cockpit' | 'chase';
  galaxy?: GalaxyView | null;
  targetId?: number | null;
  navAnchor?: number | null;
  dt?: number;
  clock?: number;
}

export function makeView(o: FakeViewOptions): FrameView {
  const t = o.time ?? 1_000_000;
  const sys = o.system;
  const bodyStates = allBodyStates(sys, t);
  const frame = viewFrame(sys, o.anchor, t, bodyStates);
  const { camSys, bodies, sites } = sceneryView(sys, t, frame, o.offset, bodyStates);
  const rot = o.rot ?? rotToSystem(frame, quat.lookRotation(v3.sub(o.lookAt ?? [0, 0, 0], o.offset)));
  const mode = o.mode ?? FlightMode.Normal;
  const hull = o.hull === undefined ? 'wisp' : o.hull;
  const stats = computeShipStats(starterLoadout(hull ?? 'wisp'));
  // By default the ship is where the camera is, turned as the camera is.
  const state: ShipState = {
    ...newShipState(stats), mode, anchor: o.anchor, pos: v3.clone(o.offset),
    rot: frame.rot ? quat.normalize(quat.mul(quat.conj(frame.rot), rot)) : rot, ...o.selfState,
  };
  const site = findSite(sys, o.anchor);
  const rocks = site ? generateAsteroids(sys, site) : [];
  const inZone = mode === FlightMode.Normal || mode === FlightMode.Landed;
  const flown = hull !== null && (inZone || mode === FlightMode.Cruise);

  return {
    time: t,
    dt: o.dt ?? 1 / 60,
    clock: o.clock ?? 10,
    system: sys,
    camera: { rot, fov: o.fov ?? 70, mode: o.cameraMode ?? 'cockpit', abs: v3.add(frame.pos, camSys) },
    bodies,
    sites,
    self: hull === null ? null : {
      id: 1, hull, state, stats, rel: o.selfRel ?? [0, 0, 0], vel: toSystem(frame, state.vel), rot: rotToSystem(frame, state.rot),
      input: o.input ?? { seq: 0, thrust: [0, 0, 1], aim: [0, 0], roll: 0, throttle: 0.6, buttons: 0 },
    },
    mode,
    ents: o.ents ?? [],
    field: site && rocks.length ? { site, rel: v3.neg(camSys), rocks, left: new Float32Array(rocks.length).fill(1) } : null,
    zone: inZone ? v3.neg(camSys) : null,
    zoneRot: inZone ? (frame.rot ?? [0, 0, 0, 1]) : null,
    surface: surfaceView(sys, t, frame, o.offset, bodyStates, flown ? { state, stats } : null),
    events: [],
    fx: { cruise: 0, charge: 0, chargeKind: 0, fold: 0, dilation: 1, heat: 0.1, boosting: false, hitFlash: 0, ...o.fx },
    galaxy: o.galaxy === undefined ? demoGalaxy([sys]) : o.galaxy,
    targetId: o.targetId ?? null,
    navAnchor: o.navAnchor ?? null,
    graphics: { quality: 2, bloom: true, resolution: 1, ...o.graphics },
  };
}

// ---------------------------------------------------------------------------------------------
// Over the ground of a landable body
// ---------------------------------------------------------------------------------------------

/** A system of `systems` with a ground base and that base; the first one found, or null. */
export function findGroundBase(systems: readonly SystemDef[]): { system: SystemDef; site: SiteDef } | null {
  for (const system of systems) {
    const site = system.sites.find((s) => s.ground !== undefined);
    if (site) return { system, site };
  }
  return null;
}

export interface SurfaceViewOptions {
  system: SystemDef;
  /** The ground base the place is given from. Must be a ground site of `system`. */
  site: SiteDef;
  /** Universe time in seconds. Default 1,000,000. With `hour`, the nearest later time at which the place has that hour. */
  time?: number;
  /** Local solar time at the ship in hours, 0..24: 12 is noon (sun highest), 0 midnight. */
  hour?: number;
  /** Where the ship is: metres east and north of the centre of the pad. Default 220 m east. */
  east?: number;
  north?: number;
  /** Instead of `east`/`north`: latitude and longitude on the body in degrees (body-fixed axes, +Y is north). */
  lat?: number;
  lon?: number;
  /** Height of the ship's lowest point above the ground beneath it, metres. Default 40. Ignored when landed. */
  height?: number;
  /**
   * The ship stands on the ground (`FlightMode.Landed`) instead of flying. Throws where the ground
   * is steeper than a ship can stand on: the simulation never has a landed ship there.
   */
  landed?: boolean;
  /** Nose direction in degrees clockwise from north, and degrees above the horizon (flying only). Default: toward the pad, level. */
  heading?: number;
  pitch?: number;
  /** Speed over the ground along the nose and rate of climb, m/s (flying only). The ship has flown at them since `since`. */
  speed?: number;
  climb?: number;
  /** Seconds the ship has been flying at `speed` and `climb` from the place given above. */
  since?: number;
  hull?: string;
  cameraMode?: 'cockpit' | 'chase';
  /** Free look of the camera: yaw and pitch in radians. */
  look?: [number, number];
  fov?: number;
  input?: ShipInput;
  fx?: Partial<FrameFx>;
  graphics?: Partial<GraphicsSettings>;
  galaxy?: GalaxyView | null;
  targetId?: number | null;
  navAnchor?: number | null;
  dt?: number;
  clock?: number;
}

/**
 * The place of a surface view, for putting more things into it: positions are given in the
 * surface frame of the body (body-fixed axes, metres from its centre).
 */
export interface SurfacePlace {
  system: SystemDef;
  site: SiteDef;
  body: BodyDef;
  ground: BodySurface;
  /** Universe time of the view. */
  time: number;
  /** Local solar time at the ship, hours 0..24. */
  hour: number;
  /** Height of the sun above the ship's horizon in degrees. */
  sunElevation: number;
  /** The surface frame of the body at `time`. */
  frame: ViewFrame;
  /** Camera position in the surface frame. */
  camLocal: Vec3;
  /** The pilot's ship as the simulation would have it, in the surface frame. */
  state: ShipState;
  /** A point `east` and `north` metres from the pad centre and `up` metres above the ground beneath it. */
  point(east: number, north: number, up: number): Vec3;
  /** A point of the surface frame relative to the camera in system axes, as `EntityView.rel` wants it. */
  rel(pos: Readonly<Vec3>): Vec3;
  /** A point of the surface frame as events carry it (`GameEvent.at`): unchanged. */
  at(pos: Readonly<Vec3>): Vec3;
  /** Orientation in system axes of something standing on the ground at `pos`, nose `heading` degrees clockwise from north. */
  standing(pos: Readonly<Vec3>, heading: number): Quat;
}

const RAD = Math.PI / 180;

/** Unit vectors east and north along the ground at the unit direction `up` (body-fixed axes). */
function compass(up: Readonly<Vec3>): { east: Vec3; north: Vec3 } {
  // North along the ground: the spin axis with its vertical part removed.
  let north: Vec3 = [-up[1] * up[0], 1 - up[1] * up[1], -up[1] * up[2]];
  if (v3.lenSq(north) < 1e-9) north = [1 - up[0] * up[0], -up[0] * up[1], -up[0] * up[2]];
  north = v3.normalize(north);
  return { east: v3.cross(north, up), north };
}

/** Longitude of a body-fixed direction, increasing the way a body with a positive period turns. */
const longitude = (d: Readonly<Vec3>): number => Math.atan2(-d[2], d[0]);

/** The star a body is lit by: body 0 of the system. Its direction from the body in body-fixed axes at `t`. */
function sunDirection(sys: SystemDef, body: BodyDef, t: number): Vec3 {
  const states = allBodyStates(sys, t);
  return v3.normalize(quat.unrotate(bodyRotation(body, t), v3.sub(states[0]!.pos, states[body.id]!.pos)));
}

/** Local solar time in hours (0..24, 12 = sun on the meridian) at the body-fixed direction `dir` at time `t`. */
export function solarHour(sys: SystemDef, body: BodyDef, dir: Readonly<Vec3>, t: number): number {
  const sun = sunDirection(sys, body, t);
  let ahead = longitude(dir) - longitude(sun);
  ahead -= 2 * Math.PI * Math.round(ahead / (2 * Math.PI));
  // A place that is ahead of the sun in the sense of the spin has had its noon already.
  const hour = 12 + (Math.sign(body.rotPeriod) || 1) * (ahead / (2 * Math.PI)) * 24;
  return ((hour % 24) + 24) % 24;
}

/** The first time at or after `t` at which the place `dir` on the body has the local solar time `hour`. */
export function timeOfHour(sys: SystemDef, body: BodyDef, dir: Readonly<Vec3>, t: number, hour: number): number {
  const day = Math.abs(body.rotPeriod);
  if (!(day > 0)) return t;
  let at = t;
  // The sun moves a little along the sky while the body turns, so a few rounds are needed.
  for (let i = 0; i < 6; i++) {
    let wait = (hour - solarHour(sys, body, dir, at)) / 24;
    if (i === 0) wait = ((wait % 1) + 1) % 1;
    else wait -= Math.round(wait);
    at += wait * day;
  }
  return at;
}

/**
 * A frame view over a real landable body near one of its ground bases, with the pilot's ship
 * flying or standing on the ground. The ship is in the surface frame of the body exactly as the
 * simulation would have it (a landed ship stands on its belly, upright on the ground normal), and
 * the view is built from that state by the functions the game uses. Also returns the place, for
 * adding entities and events.
 */
export function makeSurfaceView(o: SurfaceViewOptions): { view: FrameView; place: SurfacePlace } {
  const sys = o.system;
  const site = o.site;
  if (!site.ground) throw new Error(`site ${site.id} is not a ground base`);
  const body = sys.bodies[site.ground.body]!;
  const ground = bodySurface(sys, body.id);
  if (!ground) throw new Error(`body ${body.id} cannot be landed on`);
  const hull = o.hull ?? 'wisp';
  const stats = computeShipStats(starterLoadout(hull));
  const padRot = groundSiteRotation(site);
  const groundAt = (dir: Readonly<Vec3>): number => ground.radius + terrainHeight(ground.terrain, dir[0], dir[1], dir[2]);
  const point = (east: number, north: number, up: number): Vec3 => {
    const dir = v3.normalize(v3.add(site.ground!.pos, quat.rotate(padRot, [east, 0, -north])));
    return v3.scale(dir, groundAt(dir) + up);
  };

  // Where the ship starts, as a direction from the body centre.
  let dir: Vec3;
  if (o.lat !== undefined || o.lon !== undefined) {
    const lat = (o.lat ?? 0) * RAD;
    const lon = (o.lon ?? 0) * RAD;
    dir = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)];
  } else {
    dir = v3.normalize(point(o.east ?? 220, o.north ?? 0, 0));
  }
  const axes = compass(dir);
  // Default heading: toward the pad.
  const toPad = v3.sub(site.ground.pos, v3.scale(dir, v3.len(site.ground.pos)));
  const heading = o.heading !== undefined ? o.heading * RAD
    : v3.lenSq(toPad) > 1 ? Math.atan2(v3.dot(toPad, axes.east), v3.dot(toPad, axes.north)) : 0;
  const level = v3.add(v3.scale(axes.north, Math.cos(heading)), v3.scale(axes.east, Math.sin(heading)));

  const state = newShipState(stats);
  state.anchor = surfaceAnchor(body.id);
  if (o.landed) {
    // As the shared flight step sets a ship down: on its belly, upright on the ground normal
    // measured over its footprint, heading kept.
    const n: Vec3 = [0, 0, 0];
    const rise = terrainNormal(ground.terrain, dir[0], dir[1], dir[2], Math.max(2 * stats.radius, GROUND_BASELINE_MIN), n);
    const slope = Math.atan(rise) / RAD;
    if (slope > LAND_MAX_SLOPE_DEG) throw new Error(`the ground there slopes ${slope.toFixed(1)} degrees: too steep to stand on (limit ${LAND_MAX_SLOPE_DEG})`);
    state.mode = FlightMode.Landed;
    state.pos = v3.scale(dir, groundAt(dir) + stats.belly);
    state.rot = quat.lookRotation(v3.addScaled(level, n, -v3.dot(level, n)), n);
  } else {
    // Flying: along a circle around the body centre at `speed`, climbing at `climb`.
    const since = o.since ?? 0;
    const speed = o.speed ?? 0;
    const climb = o.climb ?? 0;
    const r0 = groundAt(dir) + stats.belly + (o.height ?? 40);
    const angle = (speed * since) / r0;
    const up = v3.add(v3.scale(dir, Math.cos(angle)), v3.scale(level, Math.sin(angle)));
    const along = v3.add(v3.scale(level, Math.cos(angle)), v3.scale(dir, -Math.sin(angle)));
    const pitch = (o.pitch ?? 0) * RAD;
    state.mode = FlightMode.Normal;
    state.pos = v3.scale(up, r0 + climb * since);
    state.vel = v3.add(v3.scale(along, speed), v3.scale(up, climb));
    state.rot = quat.lookRotation(v3.add(v3.scale(along, Math.cos(pitch)), v3.scale(up, Math.sin(pitch))), up);
  }

  const shipDir = v3.normalize(state.pos);
  const time = o.hour !== undefined ? timeOfHour(sys, body, shipDir, o.time ?? 1_000_000, o.hour) : (o.time ?? 1_000_000);
  const bodyStates = allBodyStates(sys, time);
  const frame = viewFrame(sys, state.anchor, time, bodyStates);
  const shipRot = rotToSystem(frame, state.rot);
  const look = o.look ?? [0, 0];
  const camRot = quat.mul(shipRot, quat.mul(quat.fromAxisAngle([0, 1, 0], look[0]), quat.fromAxisAngle([1, 0, 0], look[1])));
  const cameraMode = o.cameraMode ?? 'chase';
  // The cockpit camera sits a little above and ahead of the ship's origin.
  const camLocal = cameraMode === 'chase'
    ? chaseCamera(sys, frame, state.pos, camRot, stats.radius)
    : v3.add(state.pos, quat.rotate(state.rot, [0, 0.9, -2.2]));
  const { camSys, bodies, sites } = sceneryView(sys, time, frame, camLocal, bodyStates);
  const rel = (pos: Readonly<Vec3>): Vec3 => toSystem(frame, v3.sub(pos, camLocal));
  const sun = sunDirection(sys, body, time);

  const view: FrameView = {
    time,
    dt: o.dt ?? 1 / 60,
    clock: o.clock ?? 10,
    system: sys,
    camera: { rot: camRot, fov: o.fov ?? 70, mode: cameraMode, abs: v3.add(frame.pos, camSys) },
    bodies,
    sites,
    self: {
      id: 1, hull, state, stats, rel: rel(state.pos), vel: toSystem(frame, state.vel), rot: shipRot,
      input: o.input ?? { seq: 0, thrust: [0, 0, 0], aim: [0, 0], roll: 0, throttle: 0, buttons: 0 },
    },
    mode: state.mode,
    ents: [],
    field: null,
    zone: v3.neg(camSys),
    zoneRot: frame.rot ?? [0, 0, 0, 1],
    surface: surfaceView(sys, time, frame, camLocal, bodyStates, { state, stats }),
    events: [],
    fx: { cruise: 0, charge: 0, chargeKind: 0, fold: 0, dilation: 1, heat: 0.1, boosting: false, hitFlash: 0, ...o.fx },
    galaxy: o.galaxy === undefined ? demoGalaxy([sys]) : o.galaxy,
    targetId: o.targetId ?? null,
    navAnchor: o.navAnchor ?? null,
    graphics: { quality: 2, bloom: true, resolution: 1, ...o.graphics },
  };

  const place: SurfacePlace = {
    system: sys, site, body, ground, time, frame, camLocal, state,
    hour: solarHour(sys, body, shipDir, time),
    sunElevation: Math.asin(Math.max(-1, Math.min(1, v3.dot(sun, shipDir)))) / RAD,
    point,
    rel,
    at: (pos) => [pos[0], pos[1], pos[2]],
    standing(pos, deg) {
      const up = v3.normalize(pos);
      const here = compass(up);
      const n: Vec3 = [0, 0, 0];
      terrainNormal(ground.terrain, up[0], up[1], up[2], 20, n);
      const nose = v3.add(v3.scale(here.north, Math.cos(deg * RAD)), v3.scale(here.east, Math.sin(deg * RAD)));
      return rotToSystem(frame, quat.lookRotation(v3.addScaled(nose, n, -v3.dot(nose, n)), n));
    },
  };
  return { view, place };
}
