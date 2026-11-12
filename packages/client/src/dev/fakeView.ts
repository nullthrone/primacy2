/**
 * Builds synthetic `FrameView`s for development pages and screenshot tests, so renderers and the
 * HUD can be worked on without a server. Not used by the game itself.
 */
import {
  FlightMode,
  allBodyStates,
  anchorState,
  computeShipStats,
  findSite,
  generateAsteroids,
  generateSector,
  newShipState,
  quat,
  starterLoadout,
  v3,
  type GalaxyView,
  type Quat,
  type ShipState,
  type SystemDef,
  type Vec3,
} from '@primacy2/shared';
import type { EntityView, FrameFx, FrameView, GraphicsSettings } from '../contracts.ts';

export const DEMO_SERVER_ID = 'demodemodemodemo';

/** A deterministic sector for development: index 0 is a capital, 3 a black hole, 5 a neutron star. */
export function demoSector(count = 8, seed = 'demo'): SystemDef[] {
  return generateSector({ serverId: DEMO_SERVER_ID, seed, center: [0, 0, 0], radius: 18, count });
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
        online: true, linked: true, trust: 'union', tier: 'union', rulesMatch: true, allowance: null,
        players: 3, systems: summaries, links: [], gates: [],
      },
    ],
  };
}

export interface FakeViewOptions {
  system: SystemDef;
  /** Universe time in seconds. */
  time?: number;
  /** Anchor (body or site id) the camera is placed relative to. */
  anchor: number;
  /** Camera position relative to the anchor, metres. */
  offset: Vec3;
  /** Point to look at, relative to the anchor. Ignored when `rot` is given. Defaults to the anchor itself. */
  lookAt?: Vec3;
  rot?: Quat;
  fov?: number;
  mode?: FlightMode;
  /** Hull of the pilot's own ship; null for no ship. Default `wisp`. */
  hull?: string | null;
  /** Own ship position relative to the camera. Default: cockpit view (ship around the camera). */
  selfRel?: Vec3;
  selfState?: Partial<ShipState>;
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
  const anchor = anchorState(sys, o.anchor, t);
  const camAbs = v3.add(anchor.pos, o.offset);
  const rot = o.rot ?? quat.lookRotation(v3.sub(o.lookAt ?? [0, 0, 0], o.offset));
  const bodyStates = allBodyStates(sys, t);
  const bodies = sys.bodies.map((def, i) => {
    const rel = v3.sub(bodyStates[i]!.pos, camAbs);
    return { def, rel, dist: v3.len(rel) };
  });
  const sites = sys.sites.map((def) => {
    const rel = v3.sub(anchorState(sys, def.id, t).pos, camAbs);
    return { def, rel, dist: v3.len(rel) };
  });
  const mode = o.mode ?? FlightMode.Normal;
  const hull = o.hull === undefined ? 'wisp' : o.hull;
  const stats = computeShipStats(starterLoadout(hull ?? 'wisp'));
  const state: ShipState = { ...newShipState(stats), mode, anchor: o.anchor, pos: v3.clone(o.offset), rot, ...o.selfState };
  const site = findSite(sys, o.anchor);
  const rocks = site ? generateAsteroids(sys, site) : [];
  const zone = mode === FlightMode.Normal ? v3.neg(o.offset) : null;

  return {
    time: t,
    dt: o.dt ?? 1 / 60,
    clock: o.clock ?? 10,
    system: sys,
    camera: { rot, fov: o.fov ?? 70, mode: o.cameraMode ?? 'cockpit', abs: camAbs },
    bodies,
    sites,
    self: hull === null ? null : {
      id: 1, hull, state, stats, rel: o.selfRel ?? [0, 0, 0], rot: state.rot,
      input: { seq: 0, thrust: [0, 0, 1], aim: [0, 0], roll: 0, throttle: 0.6, buttons: 0 },
    },
    mode,
    ents: o.ents ?? [],
    field: site && rocks.length ? { site, rel: v3.neg(o.offset), rocks, left: new Float32Array(rocks.length).fill(1) } : null,
    zone,
    events: [],
    fx: { cruise: 0, charge: 0, chargeKind: 0, fold: 0, dilation: 1, heat: 0.1, boosting: false, hitFlash: 0, ...o.fx },
    galaxy: o.galaxy === undefined ? demoGalaxy([sys]) : o.galaxy,
    targetId: o.targetId ?? null,
    navAnchor: o.navAnchor ?? null,
    graphics: { quality: 2, bloom: true, resolution: 1, ...o.graphics },
  };
}
