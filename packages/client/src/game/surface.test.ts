/**
 * The view near the ground: what the game core hands to renderers and HUD about a ship in a
 * surface frame must be in system axes, and what stands on the ground must stay on it while the
 * body turns. The views are built by the functions the game uses (`surface.ts`), through the
 * development views of `dev/fakeView.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  DT,
  EntityKind,
  FlightMode,
  absolutePosition,
  absoluteVelocity,
  allBodyStates,
  anchorState,
  bodyRotation,
  bodySurface,
  computeShipStats,
  findSite,
  groundAltitude,
  newShipState,
  quat,
  reanchor,
  simulateShip,
  starterLoadout,
  surfaceAnchor,
  terrainNormal,
  v3,
  type Quat,
  type ShipState,
  type Vec3,
} from '@primacy2/shared';
import { LANDING_BASE, LANDING_PLANET, LANDING_STATION, landingSystem } from '../../../shared/src/sim/fixtures.ts';
import type { EntityView, FrameView } from '../contracts.ts';
import { makeSurfaceView, makeView, solarHour, timeOfHour } from '../dev/fakeView.ts';
import { Frame } from '../render/local/fx/core.ts';
import {
  CAMERA_GROUND_CLEARANCE, SURFACE_VIEW_RADII, bodyFixed, chaseCamera, liftAboveGround, surfaceView, toFrame, toSystem, viewFrame,
} from './surface.ts';

const sys = landingSystem();
const base = findSite(sys, LANDING_BASE)!;
const planet = sys.bodies[LANDING_PLANET]!;
const ground = bodySurface(sys, LANDING_PLANET)!;
const zone = surfaceAnchor(LANDING_PLANET);
const T = 1_000_000;
const NEUTRAL = { seq: 0, thrust: [0, 0, 0] as Vec3, aim: [0, 0] as [number, number], roll: 0, throttle: 0, buttons: 0 };

const angleBetween = (a: Readonly<Quat>, b: Readonly<Quat>): number =>
  2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));

/** The ship of a view relative to a site of it, in the body-fixed axes of the surface in the view. */
function shipFromSite(view: FrameView, siteId: number): Vec3 {
  const site = view.sites.find((s) => s.def.id === siteId)!;
  return quat.unrotate(view.surface!.rot, v3.sub(view.self!.rel, site.rel));
}

describe('a ship standing on the ground, in the view', () => {
  const at = (time: number) => makeSurfaceView({ system: sys, site: base, time, landed: true, east: 250, north: 40, heading: 30 });

  it('has no velocity and stays where it is relative to the ground while the body turns', () => {
    const a = at(T).view;
    const b = at(T + 600).view;
    for (const view of [a, b]) {
      expect(view.mode).toBe(FlightMode.Landed);
      expect(view.self!.vel).toEqual([0, 0, 0]);
      expect(view.surface!.ship!.landed).toBe(true);
      expect(view.surface!.ship!.height).toBeCloseTo(0, 6);
      expect(view.surface!.ship!.groundSpeed).toBe(0);
      expect(view.surface!.ship!.verticalSpeed).toBe(0);
    }
    // The same vector from the pad to the ship in body-fixed axes ...
    const fromPadA = shipFromSite(a, LANDING_BASE);
    const fromPadB = shipFromSite(b, LANDING_BASE);
    expect(v3.dist(fromPadA, fromPadB)).toBeLessThan(1e-6);
    expect(v3.len(fromPadA)).toBeGreaterThan(250);
    expect(v3.len(fromPadA)).toBeLessThan(260);
    // ... which in the system axes of the view has turned with the body: ten minutes of a four-hour day.
    const padA = a.sites.find((s) => s.def.id === LANDING_BASE)!;
    const padB = b.sites.find((s) => s.def.id === LANDING_BASE)!;
    const inSystemA = v3.sub(a.self!.rel, padA.rel);
    const inSystemB = v3.sub(b.self!.rel, padB.rel);
    expect(v3.len(inSystemA)).toBeCloseTo(v3.len(inSystemB), 6);
    expect(v3.dist(inSystemA, inSystemB)).toBeGreaterThan(20);
    // The camera did not move against the ship either, and the ship's orientation turned with the ground.
    expect(v3.len(a.self!.rel)).toBeCloseTo(v3.len(b.self!.rel), 6);
    expect(angleBetween(a.self!.rot, b.self!.rot)).toBeGreaterThan(0.2);
    expect(angleBetween(a.self!.rot, b.self!.rot)).toBeCloseTo((600 / planet.rotPeriod) * 2 * Math.PI, 6);
  });

  it('is where the simulation says it is, and so are the body, the base and the zone', () => {
    const { view, place } = at(T + 77);
    const abs = absolutePosition(place.state, sys, view.time);
    expect(v3.dist(v3.add(view.camera.abs, view.self!.rel), abs)).toBeLessThan(1e-3);
    expect(v3.dist(v3.add(view.camera.abs, view.bodies[LANDING_PLANET]!.rel), anchorState(sys, LANDING_PLANET, view.time).pos)).toBeLessThan(1e-3);
    const pad = view.sites.find((s) => s.def.id === LANDING_BASE)!;
    expect(v3.dist(v3.add(view.camera.abs, pad.rel), anchorState(sys, LANDING_BASE, view.time).pos)).toBeLessThan(1e-3);
    expect(pad.dist).toBeCloseTo(v3.len(pad.rel), 9);
    // The zone is the surface frame: its origin is the body centre, its axes are the body's.
    expect(view.zone).toEqual(view.bodies[LANDING_PLANET]!.rel);
    expect(view.zoneRot).toEqual(view.surface!.rot);
    expect(view.surface!.rot).toEqual(bodyRotation(planet, view.time));
    expect(view.surface!.body).toBe(LANDING_PLANET);
    // The camera in body-fixed axes is the camera position of the surface frame itself, to the bit.
    expect(view.surface!.cam).toEqual(place.camLocal);
    expect(v3.dist(v3.add(view.zone!, quat.rotate(view.zoneRot!, view.surface!.cam)), [0, 0, 0])).toBeLessThan(1e-6);
    // An event at a point of the ground is seen at that point.
    const spot = place.point(300, 0, 0);
    const seen = v3.add(view.zone!, quat.rotate(view.zoneRot!, place.at(spot)));
    expect(v3.dist(seen, place.rel(spot))).toBeLessThan(1e-6);
    expect(v3.dist(v3.add(view.camera.abs, seen), absolutePosition({ ...place.state, pos: spot }, sys, view.time))).toBeLessThan(1e-3);
  });

  it('stands exactly as the flight step sets a ship down there', () => {
    const { place } = at(T);
    const stats = computeShipStats(starterLoadout('wisp'));
    // The same ship set down by its flight assist from two metres above the same spot, on the
    // same heading (in free fall it would drift: this planet's spin throws things sideways).
    const s: ShipState = { ...newShipState(stats), anchor: zone, pos: v3.scale(place.state.pos, 1 + 2 / v3.len(place.state.pos)), rot: quat.clone(place.state.rot) };
    let t = T;
    for (let i = 0; i < 300 && s.mode !== FlightMode.Landed; i++, t += DT) simulateShip(s, { ...NEUTRAL, thrust: [0, -0.01, 0] }, stats, sys, t, DT);
    expect(s.mode).toBe(FlightMode.Landed);
    expect(v3.dist(s.pos, place.state.pos)).toBeLessThan(1e-4);
    expect(angleBetween(s.rot, place.state.rot)).toBeLessThan(1e-6);
    // Left alone it stays exactly there.
    const pos = [...s.pos];
    for (let i = 0; i < 300; i++, t += DT) simulateShip(s, NEUTRAL, stats, sys, t, DT);
    expect(s.pos).toEqual(pos);
  });

  it('cannot be asked for where no ship could stand', () => {
    let steep = 0;
    let standing = 0;
    for (let k = 0; k < 400; k++) {
      const opts = { system: sys, site: base, time: T, landed: true, east: 20_000 + 911 * k, north: 15_000 - 677 * k };
      try {
        const { view } = makeSurfaceView(opts);
        standing++;
        expect(view.surface!.ship!.slope).toBeLessThanOrEqual((20 * Math.PI) / 180 + 1e-9);
      } catch (err) {
        steep++;
        expect(String(err)).toMatch(/too steep/);
        // The same place can be flown over.
        expect(makeSurfaceView({ ...opts, landed: false }).view.surface!.ship!.slope).toBeGreaterThan((20 * Math.PI) / 180);
      }
    }
    expect(standing).toBeGreaterThan(200);
    expect(steep, 'some of four hundred places on a cratered planet are too steep').toBeGreaterThan(0);
  });

  it('reports the slope of the ground it stands on and the ground normal in system axes', () => {
    // Natural ground away from the pad.
    const { view, place } = makeSurfaceView({ system: sys, site: base, time: T, landed: true, east: 6000, north: -3000 });
    const ship = view.surface!.ship!;
    const up = v3.normalize(place.state.pos);
    const n: Vec3 = [0, 0, 0];
    const rise = terrainNormal(ground.terrain, up[0], up[1], up[2], 2 * view.self!.stats.radius, n);
    expect(ship.slope).toBeCloseTo(Math.atan(rise), 12);
    expect(v3.dist(ship.normal, quat.rotate(view.surface!.rot, n))).toBeLessThan(1e-12);
    expect(v3.dist(ship.up, quat.rotate(view.surface!.rot, up))).toBeLessThan(1e-12);
    expect(ship.pos).toEqual(place.state.pos);
    // The ship's own up axis is the ground normal.
    expect(v3.dist(quat.rotate(view.self!.rot, [0, 1, 0]), ship.normal)).toBeLessThan(1e-9);
  });
});

describe('a ship flying over the ground, in the view', () => {
  it('has its speed over the ground, its climb and its height from the terrain beneath it', () => {
    const opts = { system: sys, site: base, time: T, east: 3000, north: 2000, height: 120, heading: 70, speed: 80, climb: -3 };
    const { view, place } = makeSurfaceView({ ...opts, since: 20 });
    const ship = view.surface!.ship!;
    expect(view.mode).toBe(FlightMode.Normal);
    expect(ship.landed).toBe(false);
    expect(ship.groundSpeed).toBeCloseTo(80, 9);
    expect(ship.verticalSpeed).toBeCloseTo(-3, 9);
    expect(ship.height).toBeCloseTo(groundAltitude(ground, place.state.pos) - view.self!.stats.belly, 9);
    // The velocity of the view is the one over the ground, turned into system axes.
    expect(v3.len(view.self!.vel)).toBeCloseTo(Math.hypot(80, 3), 9);
    expect(v3.dist(quat.unrotate(view.zoneRot!, view.self!.vel), place.state.vel)).toBeLessThan(1e-9);
    // Twenty seconds earlier it was 1.6 km back along its path and sixty metres higher above the body centre.
    const before = makeSurfaceView({ ...opts, since: 0 }).place;
    expect(v3.len(place.state.pos) - v3.len(before.state.pos)).toBeCloseTo(-60, 6);
    expect(v3.dist(place.state.pos, before.state.pos)).toBeGreaterThan(1590);
    expect(v3.dist(place.state.pos, before.state.pos)).toBeLessThan(1610);
  });

  it('gets the same ground data whatever frame the ship is flown in', () => {
    const { view, place } = makeSurfaceView({ system: sys, site: base, time: T, east: -2000, north: 500, height: 900, heading: 200, speed: 60, climb: 4 });
    const stats = view.self!.stats;
    const bodyStates = allBodyStates(sys, T);
    const want = view.surface!.ship!;
    // The same ship expressed in the non-rotating frame of the planet and in that of a far station.
    for (const anchor of [LANDING_PLANET, LANDING_STATION]) {
      const s: ShipState = { ...place.state, pos: [...place.state.pos], vel: [...place.state.vel], rot: [...place.state.rot] };
      reanchor(s, sys, anchor, T);
      const tol = anchor === LANDING_PLANET ? 1e-6 : 0.05;
      expect(v3.dist(absolutePosition(s, sys, T), absolutePosition(place.state, sys, T))).toBeLessThan(tol);
      const frame = viewFrame(sys, anchor, T, bodyStates);
      const got = surfaceView(sys, T, frame, s.pos, bodyStates, { state: s, stats })!;
      expect(got.body).toBe(LANDING_PLANET);
      expect(got.ship!.height).toBeCloseTo(want.height, anchor === LANDING_PLANET ? 6 : 1);
      expect(got.ship!.groundSpeed).toBeCloseTo(want.groundSpeed, anchor === LANDING_PLANET ? 6 : 2);
      expect(got.ship!.verticalSpeed).toBeCloseTo(want.verticalSpeed, anchor === LANDING_PLANET ? 6 : 2);
      expect(got.ship!.slope).toBeCloseTo(want.slope, 4);
      // In its own frame the ship moves at the speed of the turning ground plus its own, not at 60 m/s.
      if (anchor === LANDING_PLANET) expect(v3.len(s.vel)).toBeGreaterThan(500);
      // The camera is at the ship here: its body-fixed position is the ship's in the surface frame.
      expect(v3.dist(got.cam, place.state.pos)).toBeLessThan(tol);
      expect(got.camHeight).toBeCloseTo(groundAltitude(ground, place.state.pos), anchor === LANDING_PLANET ? 6 : 1);
    }
    // A ship that hangs still in the planet's non-rotating frame is passed by the ground below.
    const still: ShipState = { ...place.state, pos: [...place.state.pos], vel: [...place.state.vel], rot: [...place.state.rot] };
    reanchor(still, sys, LANDING_PLANET, T);
    still.vel = [0, 0, 0];
    const drift = surfaceView(sys, T, viewFrame(sys, LANDING_PLANET, T, bodyStates), still.pos, bodyStates, { state: still, stats })!;
    expect(drift.ship!.groundSpeed).toBeGreaterThan(500);
    expect(v3.len(absoluteVelocity(still, sys, T))).toBeGreaterThan(0);
  });

  it('is told about the body only near it: within three radii of the camera', () => {
    const bodyStates = allBodyStates(sys, T);
    const frame = viewFrame(sys, LANDING_PLANET, T, bodyStates);
    const r = planet.radius;
    expect(surfaceView(sys, T, frame, [r * (SURFACE_VIEW_RADII - 0.01), 0, 0], bodyStates, null)?.body).toBe(LANDING_PLANET);
    expect(surfaceView(sys, T, frame, [0, r * (SURFACE_VIEW_RADII + 0.01), 0], bodyStates, null)).toBeNull();
    // Without a ship (docked, destroyed) the body is still there, the ship part is not.
    expect(surfaceView(sys, T, frame, [r * 1.5, 0, 0], bodyStates, null)?.ship).toBeNull();
    // At the station by the gas giant there is no ground anywhere near.
    const station = makeView({ system: sys, anchor: LANDING_STATION, offset: [0, 0, 3000], time: T });
    expect(station.surface).toBeNull();
    expect(station.zoneRot).toEqual([0, 0, 0, 1]);
    expect(station.self!.vel).toEqual([0, 0, 0]);
  });
});

describe('frames', () => {
  it('turn vectors of a surface frame into system axes and back, and leave other frames alone', () => {
    const bodyStates = allBodyStates(sys, T);
    const surface = viewFrame(sys, zone, T, bodyStates);
    const v: Vec3 = [120, -40, 7];
    expect(surface.rot).toEqual(bodyRotation(planet, T));
    expect(v3.dist(toSystem(surface, v), quat.rotate(bodyRotation(planet, T), v))).toBe(0);
    expect(v3.dist(toFrame(surface, toSystem(surface, v)), v)).toBeLessThan(1e-12);
    expect(v3.dist(toSystem(surface, v), v)).toBeGreaterThan(1);
    // The origin of a body or surface frame is the body's position of the same frame, to the bit.
    expect(surface.pos).toEqual(bodyStates[LANDING_PLANET]!.pos);
    for (const anchor of [LANDING_PLANET, LANDING_STATION]) {
      const f = viewFrame(sys, anchor, T, bodyStates);
      expect(f.rot).toBeNull();
      expect(toSystem(f, v)).toEqual(v);
      expect(toFrame(f, v)).toEqual(v);
    }
    // A ground base is a frame too (a docked ship has it as its anchor): its axes stand on the pad.
    const pad = viewFrame(sys, LANDING_BASE, T, bodyStates);
    const up = quat.rotate(pad.rot!, [0, 1, 0]);
    expect(v3.dist(up, quat.rotate(bodyRotation(planet, T), v3.normalize(base.ground!.pos)))).toBeLessThan(1e-9);
  });

  it('give the body-fixed position of a point exactly from every frame of the body', () => {
    const bodyStates = allBodyStates(sys, T);
    const rot = bodyRotation(planet, T);
    const p = v3.add(base.ground!.pos, [300, 200, -100]);
    const centre = bodyStates[LANDING_PLANET]!.pos;
    const fromSurface = bodyFixed(sys, viewFrame(sys, zone, T, bodyStates), p, ground, rot, centre);
    expect(fromSurface).toEqual(p);
    const fromBody = bodyFixed(sys, viewFrame(sys, LANDING_PLANET, T, bodyStates), quat.rotate(rot, p), ground, rot, centre);
    expect(v3.dist(fromBody, p)).toBeLessThan(1e-8);
    // Site axes: +X east, +Y up, -Z north.
    const pad = viewFrame(sys, LANDING_BASE, T, bodyStates);
    const fromPad = bodyFixed(sys, pad, [10, 50, -20], ground, rot, centre);
    expect(v3.len(v3.sub(fromPad, base.ground!.pos))).toBeCloseTo(Math.hypot(10, 50, 20), 9);
    expect(groundAltitude(ground, fromPad)).toBeCloseTo(50, 1);
    // From a frame elsewhere in the system the answer is still right to well under a metre.
    const far = viewFrame(sys, LANDING_STATION, T, bodyStates);
    const offset = v3.sub(v3.add(centre, quat.rotate(rot, p)), far.pos);
    expect(v3.dist(bodyFixed(sys, far, offset, ground, rot, centre), p)).toBeLessThan(0.05);
  });
});

describe('the camera and the terrain', () => {
  it('a camera below the ground is raised to stand clear of it, one above is left alone', () => {
    const bodyStates = allBodyStates(sys, T);
    const frame = viewFrame(sys, zone, T, bodyStates);
    const { place } = makeSurfaceView({ system: sys, site: base, time: T, east: 5000, north: 5000 });
    const spot = place.point(5000, 5000, 0);
    const under = v3.scale(spot, 1 - 30 / v3.len(spot));
    const lifted = liftAboveGround(sys, frame, under);
    expect(groundAltitude(ground, under)).toBeCloseTo(-30, 0);
    expect(groundAltitude(ground, lifted)).toBeCloseTo(CAMERA_GROUND_CLEARANCE, 6);
    // Straight up: the direction from the body centre is unchanged.
    expect(v3.dist(v3.normalize(lifted), v3.normalize(under))).toBeLessThan(1e-12);
    const over = place.point(5000, 5000, 50);
    expect(liftAboveGround(sys, frame, over)).toEqual(over);
    expect(groundAltitude(ground, liftAboveGround(sys, frame, under, 60))).toBeCloseTo(60, 6);
    // In space there is no ground to stay above.
    const station = viewFrame(sys, LANDING_STATION, T, bodyStates);
    expect(liftAboveGround(sys, station, [0, -5, 0])).toEqual([0, -5, 0]);
    // The frame of a ground base: its origin is on the ground, so a point below it is underground.
    const pad = viewFrame(sys, LANDING_BASE, T, bodyStates);
    const raised = liftAboveGround(sys, pad, [900, -40, 0], 60);
    const fixed = bodyFixed(sys, pad, raised, ground, bodyRotation(planet, T), bodyStates[LANDING_PLANET]!.pos);
    expect(groundAltitude(ground, fixed)).toBeCloseTo(60, 6);
    expect(raised[0]).toBeCloseTo(900, 0);
  });

  it('the chase camera of a landed ship never dips below the terrain, whatever way the ship faces', () => {
    let lifted = 0;
    let lowest = Infinity;
    let spots = 0;
    // Rough ground far from the pad, all round the compass, on three hulls. Every other time the
    // pilot looks up from behind the ship, which swings the camera down toward the ground.
    for (const hull of ['wisp', 'drover', 'bulwark']) {
      for (let k = 0; k < 40; k++) {
        const opts = {
          system: sys, site: base, time: T, landed: true, hull, east: 9000 + 733 * k, north: -4000 + 517 * k, heading: k * 37,
          look: (k % 2 ? [0.3 * (k % 5), 0.6] : [0, 0]) as [number, number],
        };
        let made: ReturnType<typeof makeSurfaceView>;
        try {
          made = makeSurfaceView(opts);
        } catch {
          continue; // too steep to stand on
        }
        spots++;
        const { view, place } = made;
        const height = view.surface!.camHeight;
        lowest = Math.min(lowest, height);
        // Where the plain chase position would be under the ground, the camera was raised.
        const stats = view.self!.stats;
        const plain = v3.add(place.state.pos, toFrame(place.frame, quat.rotate(view.camera.rot, [0, stats.radius * 0.8, stats.radius * 3.4])));
        if (groundAltitude(ground, plain) < CAMERA_GROUND_CLEARANCE) lifted++;
        else expect(place.camLocal).toEqual(plain);
        expect(place.camLocal).toEqual(chaseCamera(sys, place.frame, place.state.pos, view.camera.rot, stats.radius));
      }
    }
    expect(spots).toBeGreaterThan(90);
    expect(lowest).toBeGreaterThanOrEqual(CAMERA_GROUND_CLEARANCE - 1e-6);
    expect(lifted, 'some of the spots need the camera raised').toBeGreaterThan(20);
  });

  it('the camera of a landed ship is steady: frame after frame the same offset from the ship', () => {
    let first: Vec3 | null = null;
    for (let i = 0; i < 120; i++) {
      const { view } = makeSurfaceView({ system: sys, site: base, time: T + i / 60, landed: true, east: 250, north: 40, heading: 30 });
      // The ship as seen from the camera, in the camera's own axes.
      const seen = quat.unrotate(view.camera.rot, view.self!.rel);
      first ??= seen;
      expect(v3.dist(seen, first)).toBeLessThan(1e-6);
    }
  });
});

describe('time of day on the development page', () => {
  it('finds the time at which a place has the hour asked for', () => {
    const dir = v3.normalize(base.ground!.pos);
    for (const hour of [0, 6, 12, 15.5]) {
      const t = timeOfHour(sys, planet, dir, T, hour);
      expect(t).toBeGreaterThanOrEqual(T - 1);
      expect(t).toBeLessThan(T + Math.abs(planet.rotPeriod) * 1.01);
      const got = solarHour(sys, planet, dir, t);
      expect(Math.min(Math.abs(got - hour), 24 - Math.abs(got - hour))).toBeLessThan(0.01);
    }
    const noon = makeSurfaceView({ system: sys, site: base, hour: 12 }).place;
    const night = makeSurfaceView({ system: sys, site: base, hour: 0 }).place;
    const morning = makeSurfaceView({ system: sys, site: base, hour: 6.5 }).place;
    expect(noon.hour).toBeCloseTo(12, 1);
    expect(noon.sunElevation).toBeGreaterThan(20);
    expect(night.sunElevation).toBeLessThan(-20);
    // Half an hour after sunrise the sun is low, and it is higher an hour later.
    expect(morning.sunElevation).toBeGreaterThan(0);
    expect(morning.sunElevation).toBeLessThan(noon.sunElevation);
    expect(makeSurfaceView({ system: sys, site: base, hour: 7.5 }).place.sunElevation).toBeGreaterThan(morning.sunElevation);
    // In the morning the sun is rising, in the afternoon it is sinking.
    const later = makeSurfaceView({ system: sys, site: base, time: morning.time + 300 }).place;
    expect(later.sunElevation).toBeGreaterThan(morning.sunElevation);
    const afternoon = makeSurfaceView({ system: sys, site: base, hour: 16 }).place;
    expect(makeSurfaceView({ system: sys, site: base, time: afternoon.time + 300 }).place.sunElevation).toBeLessThan(afternoon.sunElevation);
  });
});

describe('effects in a surface zone', () => {
  const wreckAt = (place: ReturnType<typeof makeSurfaceView>['place'], pos: Vec3): EntityView => ({
    id: 80, info: { id: 80, kind: EntityKind.Wreck, name: 'Wreck', model: 'wisp', radius: 9 },
    rel: place.rel(pos), vel: [0, 0, 0], rot: place.standing(pos, 90), flags: 0, hull: 1, shield: 0,
  });

  it('are kept in the coordinates of the turning frame, so what is on the ground stays there', () => {
    const frame = new Frame();
    const tracks: { x: number; y: number; z: number; q: Quat }[] = [];
    let spot: Vec3 = [0, 0, 0];
    for (const time of [T, T + 1 / 60, T + 900]) {
      const { view, place } = makeSurfaceView({ system: sys, site: base, time, landed: true, east: 250, north: 40, heading: 30 });
      spot = place.point(400, -120, 9 * 0.3);
      view.ents = [wreckAt(place, spot)];
      const same = frame.begin(view, view.zone!);
      // A quarter of an hour later the body has turned by a sixteenth of a turn: nothing is stale.
      if (time > T) expect(same).toBe(true);
      const t = frame.tracks.get(80)!;
      tracks.push({ x: t.x, y: t.y, z: t.z, q: [t.qx, t.qy, t.qz, t.qw] });
      // The wreck in the coordinates of the zone: its place on the ground, at rest.
      expect(Math.hypot(t.x - spot[0], t.y - spot[1], t.z - spot[2])).toBeLessThan(1e-6);
      expect(Math.hypot(t.vx, t.vy, t.vz)).toBe(0);
      // What an effect writes into its buffers (position plus zone offset) is turned by the part
      // as a whole; that product is the camera-relative position in system axes.
      const q: Quat = [frame.qx, frame.qy, frame.qz, frame.qw];
      expect(q).toEqual(view.zoneRot);
      const drawn = quat.rotate(q, [t.x + frame.zx, t.y + frame.zy, t.z + frame.zz]);
      expect(v3.dist(drawn, view.ents[0]!.rel)).toBeLessThan(1e-6);
      // The pilot's own ship stands still in those coordinates as well.
      const own = frame.tracks.get(view.self!.id)!;
      expect(Math.hypot(own.x - place.state.pos[0], own.y - place.state.pos[1], own.z - place.state.pos[2])).toBeLessThan(1e-6);
      expect(angleBetween([own.qx, own.qy, own.qz, own.qw], place.state.rot)).toBeLessThan(1e-6);
    }
    expect(angleBetween(tracks[0]!.q, tracks[2]!.q)).toBeLessThan(1e-6);
    // In system axes the same wreck has moved by kilometres relative to the body centre meanwhile.
    const a = makeSurfaceView({ system: sys, site: base, time: T, landed: true }).place;
    const b = makeSurfaceView({ system: sys, site: base, time: T + 900, landed: true }).place;
    expect(v3.dist(toSystem(a.frame, spot), toSystem(b.frame, spot))).toBeGreaterThan(100_000);
  });

  it('take the velocity of a flying ship in the axes of the zone as well', () => {
    const frame = new Frame();
    const { view, place } = makeSurfaceView({ system: sys, site: base, time: T, east: 800, north: 100, height: 60, heading: 110, speed: 90, climb: 5 });
    const other: EntityView = {
      id: 12, info: { id: 12, kind: EntityKind.Ship, name: 'Other', model: 'lancet', radius: 10 },
      rel: place.rel(place.point(700, 0, 80)), vel: toSystem(place.frame, [30, -4, 12]), rot: place.standing(place.point(700, 0, 80), 0),
      flags: 0, hull: 1, shield: 1,
    };
    view.ents = [other];
    frame.begin(view, view.zone!);
    const own = frame.tracks.get(view.self!.id)!;
    expect(Math.hypot(own.vx - place.state.vel[0], own.vy - place.state.vel[1], own.vz - place.state.vel[2])).toBeLessThan(1e-9);
    expect(Math.hypot(own.vx, own.vy, own.vz)).toBeCloseTo(Math.hypot(90, 5), 9);
    const t = frame.tracks.get(12)!;
    expect(Math.hypot(t.vx - 30, t.vy + 4, t.vz - 12)).toBeLessThan(1e-9);
  });

  it('in space nothing is turned', () => {
    const frame = new Frame();
    const view = makeView({ system: sys, anchor: LANDING_STATION, offset: [0, 0, 3000], time: T });
    view.ents = [{
      id: 80, info: { id: 80, kind: EntityKind.Wreck, name: 'Wreck', model: 'wisp', radius: 9 },
      rel: [100, 20, -300], vel: [3, 0, 0], rot: [0, 0, 0, 1], flags: 0, hull: 1, shield: 0,
    }];
    frame.begin(view, view.zone!);
    const t = frame.tracks.get(80)!;
    expect([frame.qx, frame.qy, frame.qz, frame.qw]).toEqual([0, 0, 0, 1]);
    expect([t.x, t.y, t.z]).toEqual([100 - view.zone![0], 20 - view.zone![1], -300 - view.zone![2]]);
    expect([t.vx, t.vy, t.vz]).toEqual([3, 0, 0]);
  });
});
